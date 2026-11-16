"""Convert RedoxDB (alebusso12, used with permission) into TrEnDB redox_entries rows.

RedoxDB keeps one record per molecule (``data/molecules.json``) and one per reported value
(``data/measurements.json``: quantity e_ox, e_red, e_star_ox, e_star_red or e00, always in V vs
SCE). TrEnDB keeps one row per reported value with its molecule repeated on the row, the value
as reported against its own reference, and the value against SCE.

Rules:
- e_ox / e_red -> kind ox / red, state S0; e_star_* -> state from the molecule's excited_state
  ("MLCT (T1)" -> T1); "mixed" or no state -> review.
- An E* value with an E0,0 from the same source is "estimated" with that E0,0; e00 alone is no row.
- The value against SCE is RedoxDB's; when RedoxDB converted it from another reference that
  TrEnDB knows (e.g. Ag/AgCl (3.5 M NaCl)), e_v is the value back against that reference.
  Values RedoxDB converted from NHE/SHE stay against SCE, with RedoxDB's conversion noted.
- confidence high -> verify_level "primaria"; medium -> "secondaria"; low -> "secondaria" with
  "approximate value, verify before use". RedoxDB's notes go to verify_note (curators only).
- Every row needs a DOI (TrEnDB cites sources by DOI) and a readable SMILES; the rest is review.
- Rows enter TrEnDB as pending and are approved by two curators, like every other entry.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from . import chem
from .models import REDOX_BATCH_ROW_KEYS
from .scoring import clean_doi, clean_ref, from_sce, is_doi, normalize_redox, required_redox_error, score_redox, to_redox_doc

KEY_PREFIX = "redoxdb:"
CREDIT = "RedoxDB (alebusso12), used with permission"

E_TYPE = {
    "E1/2": "E1/2 (reversible)",
    "Ep": "Ep (irreversible, peak)",
    "Ep/2": "Ep/2 (half-peak)",
    "calc": "Computed, adiabatic",
    "reported": "Other or not stated",
    "derived": "Other or not stated",
}
STATE = {"S1": "S1", "T1": "T1", "MLCT (T1)": "T1"}
KEEP_SCE = {"SCE", "other", "NHE", "SHE"}  # imported against SCE, not back-converted


def _load(repo: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    mols = json.loads((repo / "data" / "molecules.json").read_text(encoding="utf-8"))
    meas = json.loads((repo / "data" / "measurements.json").read_text(encoding="utf-8"))
    return {m["import_key"]: m for m in mols if m.get("import_key")}, meas


def _verify(conf: str | None, notes: str | None) -> tuple[str, str | None]:
    note = (notes or "").strip() or None
    if conf == "high":
        return "primaria", note
    if conf == "low":
        return "secondaria", "approximate value, verify before use" + (f". {note}" if note else "")
    return "secondaria", note


def _original_reference(m: dict[str, Any], solvent: str | None) -> tuple[float, str]:
    """(value as reported, its reference) from RedoxDB's SCE value and ref_original."""
    v = float(m["value"])
    raw = (m.get("ref_original") or "").strip()
    ref = clean_ref(raw) if raw else "SCE"
    if not ref or ref in KEEP_SCE:
        return v, "SCE"
    back = from_sce(v, ref, solvent)
    return (v, "SCE") if math.isnan(back) else (back, ref)


def convert(repo: str | Path) -> dict[str, Any]:
    """-> {"rows": [...], "review": [...], "skipped": [...], "counts": {...}}"""
    mols, meas = _load(Path(repo))
    by_mol: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in meas:
        by_mol[m["molecule_key"]].append(m)

    rows: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()

    def to_review(m: dict[str, Any], why: str) -> None:
        review.append({"reason": why, "measurement": m, "molecule": mols.get(m["molecule_key"], {}).get("name")})
        counts["review"] += 1

    for m in meas:
        q = m["quantity"]
        mol = mols.get(m["molecule_key"])
        if q == "e00":
            skipped.append({"reason": "E0,0 alone is not a redox value (kept on the E* rows)", "measurement": m})
            counts["skipped_e00"] += 1
            continue
        if mol is None:
            to_review(m, "molecule not found in molecules.json")
            continue
        smiles = (mol.get("smiles") or "").strip()
        if not smiles:
            to_review(m, "no SMILES")
            continue
        structure_ok = None
        if chem.HAS_RDKIT:
            structure_ok = chem.parse_mol(smiles) is not None
            if not structure_ok:
                to_review(m, "SMILES not readable by RDKit")
                continue
        doi = clean_doi(m.get("doi") or "")
        if not is_doi(doi):
            to_review(m, "no DOI (TrEnDB cites sources by DOI)")
            continue

        excited = q.startswith("e_star_")
        state = "S0"
        if excited:
            state = STATE.get(mol.get("excited_state") or "", "")
            if not state:
                to_review(m, f"excited state not assigned ({mol.get('excited_state') or 'none'})")
                continue

        solvent = m.get("solvent") or mol.get("solvent")
        calc = m.get("kind") == "computational"
        e_v, e_ref = (float(m["value"]), "SCE") if calc else _original_reference(m, solvent)
        e00, e00_note = None, ""
        if excited:
            e00s = [x for x in by_mol[m["molecule_key"]] if x["quantity"] == "e00"]
            same = [x for x in e00s if clean_doi(x.get("doi") or "") == doi]
            if same:
                e00, e00_note = float(same[0]["value"]), "E0,0 from the same source (RedoxDB)"
            elif e00s:
                other = clean_doi(e00s[0].get("doi") or "")
                e00 = float(e00s[0]["value"])
                e00_note = "E0,0 from " + (f"doi:{other}" if other else "another source") + " (RedoxDB)"
        estimated = excited and e00 is not None
        lmax = mol.get("lambda_abs_nm")
        payload: dict[str, Any] = {
            "name": mol.get("iupac_name") or mol["name"],
            "commercial_name": mol["name"] if mol.get("iupac_name") else "",
            "cas": mol.get("cas") or "",
            "cls": mol.get("class") or "",
            "smiles": smiles,
            "kind": "ox" if q.endswith("_ox") else "red",
            "state": state,
            "e": e_v,
            "unit": "v",
            "ref": e_ref,
            "origin": "calc" if calc else "exp",
            "e_type": E_TYPE.get(m.get("value_type") or "", "Other or not stated"),
            "excited_from": "estimated" if estimated else "",
            "e00": e00 if e00 is not None else "",
            "e00_note": e00_note,
            "solvent": "" if calc else (solvent or ""),
            "electrolyte": "" if calc else (m.get("electrolyte") or mol.get("electrolyte") or ""),
            "tech": "" if calc else (m.get("method") or ""),
            "func": (m.get("method") or "") if calc else "",
            "solv": (solvent or "") if calc else "",
            "category": mol.get("category") or "",
            "activated_group": (mol.get("functional_groups") or [""])[0],
            "uv_lmax": int(round(lmax)) if isinstance(lmax, (int, float)) and 100 <= lmax <= 1500 else "",
            "tau_ns": mol.get("tau_ns") if (excited and mol.get("tau_ns") is not None) else "",
            "cite": m.get("source") or "",
            "doi": doi,
        }
        f = normalize_redox(payload)
        ctx = {"structureOk": structure_ok, "doiResolves": None, "same": None}
        why = required_redox_error(f, ctx)
        if why:
            to_review(m, why)
            continue
        sc = score_redox(f, ctx)
        doc = to_redox_doc(f, sc)
        doc["e_sce"] = round(float(m["value"]), 3)  # RedoxDB's own value against SCE
        if m.get("conversion") and (e_ref != "SCE" or clean_ref(m.get("ref_original") or "") in ("NHE", "SHE")):
            doc["e_reported"] = f"{doc['e_reported']} (RedoxDB: {m['conversion']})"
        if mol.get("excited_state") == "MLCT (T1)" and excited:
            doc["structure_note"] = "Excited state: MLCT (T1)"
        doc["verify_level"], doc["verify_note"] = _verify(m.get("confidence"), m.get("notes"))
        doc["source_kind"] = "import"
        doc["import_key"] = KEY_PREFIX + m["import_key"]
        rows.append({k: doc[k] for k in REDOX_BATCH_ROW_KEYS if k in doc and doc[k] is not None})
        counts["rows"] += 1
        counts[f"{doc['kind']}_{doc['state']}"] += 1
        counts["verify_" + doc["verify_level"] + ("_low" if m.get("confidence") == "low" else "")] += 1

    return {"rows": rows, "review": review, "skipped": skipped, "counts": dict(counts)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Convert a local RedoxDB clone into a TrEnDB redox batch (pending rows).")
    ap.add_argument("redoxdb", help="Path to a clone of github.com/alebusso12/RedoxDB")
    ap.add_argument("-o", "--out", default="extracted/redoxdb-batch.json", help="Batch to upload on the PhotoreDBox review page (photoredbox/admin.html).")
    ap.add_argument("--review", default="extracted/needs_review_redox.json", help="Values that need a curator first.")
    args = ap.parse_args(argv)
    res = convert(args.redoxdb)
    for path, data in ((args.out, res["rows"]), (args.review, res["review"])):
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    c = res["counts"]
    print(
        f"{c.get('rows', 0)} rows -> {args.out}; {c.get('review', 0)} to review -> {args.review}; "
        f"{c.get('skipped_e00', 0)} E0,0 values used on E* rows only."
    )
    print(json.dumps(c, indent=1, sort_keys=True))
    print(f"Credit: {CREDIT}.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
