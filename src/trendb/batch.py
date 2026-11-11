"""Batch generation, validation, deduplication, and review staging for docs/batches/."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from . import chem, scoring
from .clean_fields import normalize_row_fields
from .client import TrEnDBClient
from .models import BATCH_ROW_KEYS, Entry
from .pdf_extract import ExtractedCandidate
from .resolvers import Resolver

_LINK_FORBIDDEN_RE = re.compile(r"https?://|ezproxy|unibo\.it", re.IGNORECASE)


@dataclass
class BatchBuildResult:
    ready_rows: list[dict[str, Any]]
    review_items: list[dict[str, Any]]
    skipped_duplicates: list[dict[str, Any]]
    batch_path: Path | None = None
    review_path: Path | None = None
    report_path: Path | None = None


def _same_value(a_origin: str, a_et: float, a_doi: str | None, b_origin: str, b_et: float, b_doi: str | None) -> bool:
    """Match Ent.sameValue in docs/assets/common.js."""
    if (a_origin or "exp") != (b_origin or "exp"):
        return False
    dv = abs(float(a_et) - float(b_et))
    x = scoring.clean_doi(a_doi or "").lower()
    y = scoring.clean_doi(b_doi or "").lower()
    return dv <= 1.0 if (x and x == y) else dv <= 0.1


def _load_existing_batch_rows(batches_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not batches_dir.is_dir():
        return rows
    for fpath in sorted(batches_dir.glob("batch-*.json")):
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            if isinstance(data, list):
                rows.extend(data)
        except Exception:
            continue
    return rows


def next_batch_path(batches_dir: Path) -> Path:
    max_num = 0
    if batches_dir.is_dir():
        for p in batches_dir.glob("batch-*.json"):
            m = re.match(r"batch-(\d+)\.json$", p.name)
            if m:
                max_num = max(max_num, int(m.group(1)))
    return batches_dir / f"batch-{max_num + 1:03d}.json"


def _doi_slug(doi: str | None, fallback_stem: str) -> str:
    if doi and "/" in doi:
        suffix = doi.split("/", 1)[1]
        slug = re.sub(r"[^A-Za-z0-9._-]+", "_", suffix).strip("_")
        if slug:
            return slug[:60]
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", fallback_stem).strip("_")
    return (slug or "pdf")[:60]


def validate_batch_rows(rows: Iterable[dict[str, Any]]) -> list[str]:
    """Mirror tools/check-links.mjs + PostgREST uniform-key and schema constraints."""
    problems: list[str] = []
    key_sets: set[tuple[str, ...]] = set()
    for i, r in enumerate(rows):
        key_sets.add(tuple(sorted(r.keys())))
        ik = r.get("import_key") or f"row[{i}]"
        for k, v in r.items():
            if isinstance(v, str) and _LINK_FORBIDDEN_RE.search(v):
                problems.append(f"{ik} {k}: contains a URL or forbidden proxy reference")
        if r.get("doi") and not scoring.is_doi(r["doi"]):
            problems.append(f"{ik}: '{r['doi']}' is not a valid DOI")
        if r.get("cas") and not scoring.cas_valid(r["cas"]):
            problems.append(f"{ik}: '{r['cas']}' is not a valid CAS number")
        if r.get("uv_lmax") is not None and not (isinstance(r["uv_lmax"], int) and not isinstance(r["uv_lmax"], bool) and 100 <= r["uv_lmax"] <= 1500):
            problems.append(f"{ik}: uv_lmax must be an int between 100 and 1500")
        if r.get("uv_eps") is not None and not (isinstance(r["uv_eps"], int) and not isinstance(r["uv_eps"], bool) and r["uv_eps"] >= 0):
            problems.append(f"{ik}: uv_eps must be a non-negative int")
        if r.get("direct_exc") is not None:
            de = r["direct_exc"]
            if not isinstance(de, dict) or any(
                not isinstance(k, str) or not k.strip() or not isinstance(v, int) or isinstance(v, bool) or not (100 <= v <= 1500)
                for k, v in de.items()
            ):
                problems.append(f"{ik}: direct_exc must be a {{source: wavelength_int}} dict")
        if not r.get("smiles"):
            problems.append(f"{ik}: smiles is required")
    if len(key_sets) > 1:
        problems.append("Batch rows do not have uniform keys (required by PostgREST bulk insert).")
    return problems


def _build_scoring_payload(c: ExtractedCandidate) -> dict[str, Any]:
    return {
        "name": c.name,
        "cas": c.cas or "",
        "cls": c.cls or "",
        "smiles": c.smiles or "",
        "role": c.role,
        "et": c.raw_et if c.raw_et is not None else c.et_kcal,
        "unit": c.unit,
        "unc": c.raw_unc if c.raw_unc is not None else c.et_unc,
        "origin": c.origin,
        "kind": c.et_type,
        "tech": c.tech or ("" if c.origin == "calc" or c.method == "Not stated" else c.method),
        "solvent": c.solvent or "",
        "temp": c.temp or "",
        "func": c.func or "",
        "basis": c.basis or "",
        "solv": c.solv or "",
        "cite": c.citation or "",
        "doi": c.doi or "",
        "loc": c.location or "",
        "quote": c.quote or "",
        "uv_lmax": c.uv_lmax,
        "uv_eps": c.uv_eps,
        "uv_cond": c.uv_cond or "",
        "direct_exc": c.direct_exc,
    }


def _to_uniform_batch_row(c: ExtractedCandidate, import_key: str, sc: dict[str, Any]) -> dict[str, Any]:
    cas = scoring.clean_cas(c.cas) if c.cas else None
    if cas and not scoring.cas_valid(cas):
        cas = None
    doi = scoring.clean_doi(c.doi) if c.doi else None
    if doi and not scoring.is_doi(doi):
        doi = None

    row = {
        "import_key": import_key,
        "name": c.name[:200],
        "cas": cas,
        "smiles": c.smiles,
        "smiles_checked": bool(c.smiles_checked),
        "structure_note": c.structure_note,
        "cls": c.cls[:80] if c.cls else None,
        "role": c.role if c.role in ("acceptor", "donor", "both") else "acceptor",
        "origin": "calc" if c.origin == "calc" else "exp",
        "et_kcal": scoring.round1(c.et_kcal),
        "et_unc": scoring.round2(c.et_unc) if c.et_unc is not None else None,
        "et_reported": c.et_reported,
        "et_type": c.et_type,
        "method": c.method,
        "conditions": c.conditions,
        "citation": c.citation,
        "doi": doi,
        "location": c.location,
        "quote": c.quote,
        "evidence": c.evidence,
        "verify_level": c.verify_level,
        "verify_note": c.verify_note,
        "uv_lmax": c.uv_lmax,
        "uv_eps": c.uv_eps,
        "uv_cond": c.uv_cond,
        "direct_exc": c.direct_exc,
        "source_kind": c.source_kind or "literature",
        "score": int(sc["total"]),
        "score_items": sc["items"],
    }
    # Ensure exact uniform key ordering matching BATCH_ROW_KEYS and concise field formatting
    cleaned = normalize_row_fields(row)
    return {k: cleaned[k] for k in BATCH_ROW_KEYS}


def _candidate_to_review_dict(c: ExtractedCandidate, reason: str, score: int | None = None) -> dict[str, Any]:
    d = asdict(c)
    d["review_reason"] = reason
    if score is not None:
        d["score_preview"] = score
    return d


def build_batch(
    candidates: Iterable[ExtractedCandidate],
    *,
    resolver: Resolver,
    batches_dir: str | Path = "docs/batches",
    db_client: TrEnDBClient | None = None,
    min_score: int = 0,
    write_batch: bool = False,
    batch_file: str | Path | None = None,
    out_dir: str | Path = "extracted",
) -> BatchBuildResult:
    """Validate, score, deduplicate, and package extracted candidates into batch/review files."""
    bdir = Path(batches_dir)
    existing_batch_rows = _load_existing_batch_rows(bdir)
    used_import_keys = {str(r.get("import_key")) for r in existing_batch_rows if r.get("import_key")}

    reference_entries: list[dict[str, Any]] = list(existing_batch_rows)
    if db_client is not None:
        for e in db_client.fetch_entries():
            reference_entries.append(e.to_dict())

    # Index reference entries by canonical SMILES and CAS for consistency & duplicate checks
    by_can: dict[str, list[dict[str, Any]]] = {}
    by_cas: dict[str, list[dict[str, Any]]] = {}
    for ref in reference_entries:
        smi = (ref.get("smiles") or "").strip()
        can = chem.canonical_smiles(smi, isomeric=True) if (smi and chem.HAS_RDKIT) else smi
        if can:
            by_can.setdefault(can, []).append(ref)
        cas = scoring.clean_cas(ref.get("cas")) if ref.get("cas") else ""
        if cas and scoring.cas_valid(cas):
            by_cas.setdefault(cas, []).append(ref)

    ready_rows: list[dict[str, Any]] = []
    review_items: list[dict[str, Any]] = []
    skipped_duplicates: list[dict[str, Any]] = []
    slug_counters: dict[tuple[str, str], int] = {}

    for cand in candidates:
        smi = (cand.smiles or "").strip()
        struct_ok = chem.structure_ok(smi) if smi else False
        if struct_ok is None:
            struct_ok = bool(smi)
        if not smi or struct_ok is False:
            review_items.append(
                _candidate_to_review_dict(
                    cand,
                    "Missing or unparseable SMILES (fill 'smiles' manually and re-run build-batch).",
                )
            )
            continue

        can = chem.canonical_smiles(smi, isomeric=True) if chem.HAS_RDKIT else smi
        cand.smiles = can or smi

        iupac = resolver.resolve_iupac(cand.smiles)
        if iupac and iupac.strip() and iupac.strip().lower() != (cand.name or "").strip().lower():
            orig_name = (cand.name or "").strip()
            cand.name = iupac.strip()[:200]
            if orig_name and orig_name != "(unnamed candidate)":
                prefix = f"Paper name: {orig_name}."
                if not cand.structure_note:
                    cand.structure_note = prefix
                elif prefix not in cand.structure_note:
                    cand.structure_note = f"{prefix} {cand.structure_note}"

        if not cand.cas and not resolver.offline:
            cas_hits = resolver.lookup_cas_from_smiles(cand.smiles)
            if cas_hits:
                cand.cas = cas_hits[0]

        same_refs: list[dict[str, Any]] = []
        seen_ref_ids: set[int] = set()
        if cand.cas and cand.cas in by_cas:
            for ref in by_cas[cand.cas]:
                if id(ref) not in seen_ref_ids:
                    seen_ref_ids.add(id(ref))
                    same_refs.append(ref)
        if cand.smiles in by_can:
            for ref in by_can[cand.smiles]:
                ref_cas = scoring.clean_cas(ref.get("cas")) if ref.get("cas") else ""
                if cand.cas and ref_cas and ref_cas != cand.cas:
                    continue
                if id(ref) not in seen_ref_ids:
                    seen_ref_ids.add(id(ref))
                    same_refs.append(ref)

        # Duplicate check against existing batches + DB + already accepted in this run
        is_dup = False
        for ref in same_refs:
            if _same_value(cand.origin, cand.et_kcal, cand.doi, ref.get("origin", "exp"), float(ref["et_kcal"]), ref.get("doi")):
                is_dup = True
                skipped_duplicates.append(
                    {
                        "name": cand.name,
                        "smiles": cand.smiles,
                        "et_kcal": cand.et_kcal,
                        "origin": cand.origin,
                        "doi": cand.doi,
                        "matched_name": ref.get("name"),
                        "matched_import_key": ref.get("import_key"),
                    }
                )
                break
        if is_dup:
            continue

        f = scoring.normalize(_build_scoring_payload(cand))
        doi_ok = resolver.doi_resolves(cand.doi) if cand.doi else None
        ctx = {"structureOk": True, "doiResolves": doi_ok, "same": same_refs}

        req_err = scoring.required_error(f, ctx)
        sc = scoring.score_entry(f, ctx)
        if req_err:
            review_items.append(_candidate_to_review_dict(cand, req_err, score=sc["total"]))
            continue

        if sc["total"] < min_score:
            review_items.append(
                _candidate_to_review_dict(cand, f"Score {sc['total']} below --min-score {min_score}.", score=sc["total"])
            )
            continue

        slug = _doi_slug(cand.doi, Path(cand.pdf_file or "pdf").stem)
        ckey = (slug, cand.origin)
        idx = slug_counters.get(ckey, 0) + 1
        while f"{slug}:{cand.origin}:{idx}" in used_import_keys:
            idx += 1
        slug_counters[ckey] = idx
        import_key = f"{slug}:{cand.origin}:{idx}"
        used_import_keys.add(import_key)

        row = _to_uniform_batch_row(cand, import_key, sc)
        ready_rows.append(row)

        # Register newly accepted row for within-run deduplication
        if cand.smiles:
            by_can.setdefault(cand.smiles, []).append(row)
        if cand.cas:
            by_cas.setdefault(cand.cas, []).append(row)

    # Validate batch rows strictly before writing anywhere
    if ready_rows:
        problems = validate_batch_rows(ready_rows)
        if problems:
            raise ValueError("Generated batch failed validation:\n" + "\n".join(problems))

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    result = BatchBuildResult(
        ready_rows=ready_rows,
        review_items=review_items,
        skipped_duplicates=skipped_duplicates,
    )

    if write_batch and ready_rows:
        target = Path(batch_file) if batch_file else next_batch_path(bdir)
        target.parent.mkdir(parents=True, exist_ok=True)
        merged: list[dict[str, Any]] = []
        if target.is_file():
            existing_target = json.loads(target.read_text(encoding="utf-8"))
            seen_ik = {r.get("import_key") for r in existing_target}
            # Harmonize uniform keys if appending to a pre-existing file (e.g., batch-001 without "cas")
            for old in existing_target:
                for k in BATCH_ROW_KEYS:
                    old.setdefault(k, None)
                merged.append({k: old[k] for k in BATCH_ROW_KEYS})
            for r in ready_rows:
                if r["import_key"] not in seen_ik:
                    merged.append(r)
        else:
            merged = ready_rows

        problems = validate_batch_rows(merged)
        if problems:
            raise ValueError("Merged batch failed validation:\n" + "\n".join(problems))
        target.write_text(json.dumps(merged, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        result.batch_path = target

        # Update docs/batches/index.json only when writing inside batches_dir
        if target.parent.resolve() == bdir.resolve():
            idx_file = bdir / "index.json"
            if idx_file.is_file():
                idx_data = json.loads(idx_file.read_text(encoding="utf-8"))
            else:
                idx_data = {"files": []}
            files_list = list(idx_data.get("files") or [])
            if target.name not in files_list:
                files_list.append(target.name)
            idx_data["files"] = files_list
            idx_file.write_text(json.dumps(idx_data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    elif ready_rows:
        dry_batch = out_path / "batch-preview.json"
        dry_batch.write_text(json.dumps(ready_rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        result.batch_path = dry_batch

    if review_items:
        rev_file = out_path / "needs_review.json"
        rev_file.write_text(json.dumps(review_items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        result.review_path = rev_file

    report_file = out_path / "report.md"
    report_file.write_text(render_report(result), encoding="utf-8")
    result.report_path = report_file
    return result


def build_batch_from_review(
    review_json: str | Path,
    *,
    resolver: Resolver,
    batches_dir: str | Path = "docs/batches",
    db_client: TrEnDBClient | None = None,
    min_score: int = 0,
    write_batch: bool = False,
    batch_file: str | Path | None = None,
    out_dir: str | Path = "extracted",
) -> BatchBuildResult:
    """Promote manually completed items from needs_review.json into a validated batch."""
    items = json.loads(Path(review_json).read_text(encoding="utf-8"))
    allowed_fields = set(ExtractedCandidate.__dataclass_fields__.keys())
    candidates = []
    for item in items:
        cand = ExtractedCandidate(**{k: v for k, v in item.items() if k in allowed_fields})
        if cand.smiles and cand.structure_note and "could not be resolved" in cand.structure_note.lower():
            cand.structure_note = "Structure supplied manually during review."
        candidates.append(cand)
    return build_batch(
        candidates,
        resolver=resolver,
        batches_dir=batches_dir,
        db_client=db_client,
        min_score=min_score,
        write_batch=write_batch,
        batch_file=batch_file,
        out_dir=out_dir,
    )


def render_report(res: BatchBuildResult) -> str:
    lines = [
        "# TrEnDB PDF Extraction Report",
        "",
        f"- **Ready for batch**: {len(res.ready_rows)}",
        f"- **Needs manual review**: {len(res.review_items)}",
        f"- **Skipped duplicates**: {len(res.skipped_duplicates)}",
        "",
    ]
    if res.batch_path:
        lines.append(f"Batch JSON written to: `{res.batch_path}`")
    if res.review_path:
        lines.append(f"Review staging written to: `{res.review_path}`")
    if res.ready_rows:
        lines.extend(["", "## Ready Entries", ""])
        for r in res.ready_rows:
            lines.append(
                f"- `{r['import_key']}` | **{r['name']}** | {r['et_kcal']} kcal/mol ({r['origin']}) | "
                f"score {r['score']} | `{r['smiles']}`"
            )
    if res.review_items:
        lines.extend(["", "## Needs Review", ""])
        for item in res.review_items:
            lines.append(
                f"- **{item.get('name')}** ({item.get('et_kcal')} kcal/mol, {item.get('origin')}) "
                f"[{item.get('pdf_file')} {item.get('location')}]: {item.get('review_reason')}"
            )
    if res.skipped_duplicates:
        lines.extend(["", "## Skipped Duplicates", ""])
        for dup in res.skipped_duplicates:
            lines.append(
                f"- **{dup['name']}** ({dup['et_kcal']} kcal/mol, {dup['origin']}) matched `{dup.get('matched_import_key') or dup.get('matched_name')}`"
            )
    return "\n".join(lines) + "\n"
