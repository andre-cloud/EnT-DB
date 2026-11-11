"""Query builder, metadata/chemical filtering, grouping, and exports for TrEnDB."""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Iterator

from . import chem
from .models import KCAL_PER_EV, KJ_PER_KCAL, Entry, MoleculeGroup
from .scoring import clean_cas, clean_doi

if TYPE_CHECKING:
    import pandas as pd


def _to_kcal(value: float | None, unit: str) -> float | None:
    if value is None:
        return None
    u = unit.lower()
    if u in ("kcal", "kcal/mol"):
        return float(value)
    if u in ("kj", "kj/mol"):
        return float(value) / KJ_PER_KCAL
    if u == "ev":
        return float(value) * KCAL_PER_EV
    raise ValueError(f"Unsupported energy unit: {unit!r}")


class SearchResult:
    """Filtered list of Entry objects with export and grouping helpers."""

    def __init__(self, entries: list[Entry], similarity_scores: dict[int, float] | None = None) -> None:
        self.entries = entries
        self.similarity_scores = similarity_scores or {}

    def __len__(self) -> int:
        return len(self.entries)

    def __iter__(self) -> Iterator[Entry]:
        return iter(self.entries)

    def __getitem__(self, idx: int | slice) -> Any:
        return self.entries[idx]

    def __repr__(self) -> str:
        return f"SearchResult(count={len(self.entries)})"

    def group_by_molecule(self) -> list[MoleculeGroup]:
        return group_by_molecule(self.entries)

    def to_dicts(self, include_similarity: bool = True) -> list[dict[str, Any]]:
        return [e.to_dict(include_similarity=include_similarity) for e in self.entries]

    def to_json(self, path: str | Path, *, indent: int = 2) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.to_dicts(), indent=indent, ensure_ascii=False), encoding="utf-8")
        return out

    def to_csv(self, path: str | Path) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        rows = self.to_dicts()
        if not rows:
            out.write_text("", encoding="utf-8")
            return out
        fieldnames = list(rows[0].keys())
        for r in rows[1:]:
            for k in r:
                if k not in fieldnames:
                    fieldnames.append(k)
        with out.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            for r in rows:
                flat = {
                    k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v
                    for k, v in r.items()
                }
                writer.writerow(flat)
        return out

    def to_dataframe(self) -> "pd.DataFrame":
        try:
            import pandas as pd
        except ImportError as exc:  # pragma: no cover
            raise ImportError("pandas is required for to_dataframe(). Install with `pip install trendb[data]`.") from exc
        return pd.DataFrame(self.to_dicts())

    def to_sdf(self, path: str | Path) -> int:
        return chem.write_sdf(self.entries, path)

    def stats(self, *, top_n: int = 10) -> Any:
        from .stats import analyze_entries

        return analyze_entries(self.entries, top_n=top_n)

    def exp_vs_calc(self) -> Any:
        from .stats import compare_exp_calc

        return compare_exp_calc(self.entries)

    def molecule_spread(self, *, origin: str | None = None, min_count: int = 2) -> list[Any]:
        from .stats import molecule_spread

        return molecule_spread(self.entries, origin=origin, min_count=min_count)

    def descriptors(self) -> list[dict[str, Any]]:
        from .stats import compute_descriptors

        return compute_descriptors(self.entries)


def group_by_molecule(entries: Iterable[Entry]) -> list[MoleculeGroup]:
    """Group entries by molecule: CAS -> idcode/canonical SMILES -> raw SMILES.

    Entries with distinct CAS numbers are never merged, matching Ent.groupByMolecule.
    """
    groups: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}

    def fits(g: dict[str, Any] | None, cas: str) -> bool:
        return bool(g is not None and not (cas and g["cas"] and g["cas"] != cas))

    for e in entries:
        cas = clean_cas(e.cas) if e.cas else ""
        can = chem.canonical_smiles(e.smiles, isomeric=True) if chem.HAS_RDKIT else None
        struct_key = e.idcode or can or ""
        raw_smi = (e.smiles or "").strip()

        g: dict[str, Any] | None = None
        if cas:
            g = by_key.get(f"cas:{cas}")
        if g is None and struct_key and fits(by_key.get(f"st:{struct_key}"), cas):
            g = by_key[f"st:{struct_key}"]
        if g is None and raw_smi and fits(by_key.get(f"smi:{raw_smi}"), cas):
            g = by_key[f"smi:{raw_smi}"]
        if g is None:
            g = {"cas": "", "items": []}
            groups.append(g)

        g["items"].append(e)
        if cas and not g["cas"]:
            g["cas"] = cas
        if cas:
            by_key[f"cas:{cas}"] = g
        if struct_key:
            by_key[f"st:{struct_key}"] = g
        if raw_smi:
            by_key[f"smi:{raw_smi}"] = g

    result: list[MoleculeGroup] = []
    for g in groups:
        items: list[Entry] = g["items"]
        first = items[0]
        result.append(
            MoleculeGroup(
                cas=g["cas"] or None,
                name=first.name,
                smiles=first.smiles,
                idcode=first.idcode,
                entries=items,
            )
        )
    return result


def filter_entries(
    entries: Iterable[Entry],
    *,
    q: str | None = None,
    regex: str | None = None,
    cas: str | None = None,
    origin: str | None = None,
    role: str | None = None,
    cls: str | None = None,
    doi: str | None = None,
    et_min: float | None = None,
    et_max: float | None = None,
    et_unit: str = "kcal",
    min_score: int | None = None,
    verify_level: str | None = None,
    has_cas: bool | None = None,
    has_uv: bool | None = None,
    exact_smiles: str | None = None,
    substructure: str | None = None,
    smarts: bool = False,
    similarity_smiles: str | None = None,
    similarity_threshold: float = 0.5,
    sort_by: str = "added",
    limit: int | None = None,
) -> SearchResult:
    """Filter and sort TrEnDB entries using metadata and RDKit structure criteria."""
    q_norm = (q or "").strip().lower()
    rx = re.compile(regex, re.IGNORECASE) if regex else None
    cas_norm = clean_cas(cas) if cas else ""
    doi_norm = clean_doi(doi).lower() if doi else ""
    cls_norm = (cls or "").strip().lower()
    min_kcal = _to_kcal(et_min, et_unit)
    max_kcal = _to_kcal(et_max, et_unit)

    if exact_smiles or substructure or similarity_smiles:
        chem.require_rdkit()

    out: list[Entry] = []
    sim_scores: dict[int, float] = {}

    for idx, e in enumerate(entries):
        if origin and e.origin != origin:
            continue
        if cas_norm and not (e.cas or "").startswith(cas_norm):
            continue
        if role and e.role != role and e.role != "both":
            continue
        if cls_norm and (e.cls or "").strip().lower() != cls_norm:
            continue
        if doi_norm and clean_doi(e.doi or "").lower() != doi_norm:
            continue
        if min_kcal is not None and not (e.et_kcal >= min_kcal):
            continue
        if max_kcal is not None and not (e.et_kcal <= max_kcal):
            continue
        if min_score is not None and (e.score is None or e.score < min_score):
            continue
        if verify_level and e.verify_level != verify_level:
            continue
        if has_cas is True and not e.cas:
            continue
        if has_cas is False and e.cas:
            continue
        has_uv_data = e.uv_lmax is not None or e.uv_eps is not None or bool(e.uv_cond)
        if has_uv is True and not has_uv_data:
            continue
        if has_uv is False and has_uv_data:
            continue

        haystack = " ".join(
            str(x)
            for x in (e.name, e.cas, e.smiles, e.citation, e.cls, e.method, e.doi, e.quote, e.evidence)
            if x
        )
        if q_norm and q_norm not in haystack.lower():
            continue
        if rx and not rx.search(haystack):
            continue

        if exact_smiles and not chem.exact_match(exact_smiles, e.smiles):
            continue
        if substructure and not chem.substructure_match(substructure, e.smiles, smarts=smarts):
            continue

        sim_val: float | None = None
        if similarity_smiles:
            sim_val = chem.tanimoto_similarity(similarity_smiles, e.smiles)
            if sim_val is None or sim_val < similarity_threshold:
                continue
            sim_scores[idx] = sim_val

        # Copy entry only when attaching runtime similarity score so cached entries stay clean.
        if sim_val is not None:
            e = Entry.from_dict({**e.to_dict(), "similarity": round(sim_val, 4)})
        out.append(e)

    if sort_by == "et_asc":
        out.sort(key=lambda x: x.et_kcal)
    elif sort_by == "et_desc":
        out.sort(key=lambda x: x.et_kcal, reverse=True)
    elif sort_by == "score_desc":
        out.sort(key=lambda x: (-(x.score or 0), x.created_at or ""))
    elif sort_by == "similarity" or (similarity_smiles and sort_by == "added"):
        out.sort(key=lambda x: x.similarity or 0.0, reverse=True)
    else:
        out.sort(key=lambda x: (x.created_at or "", x.id or ""))

    if limit is not None:
        out = out[:limit]

    return SearchResult(out, similarity_scores=sim_scores)


class QueryBuilder:
    """Fluent query interface bound to a TrEnDBClient."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._params: dict[str, Any] = {}

    def text(self, q: str) -> "QueryBuilder":
        self._params["q"] = q
        return self

    def regex(self, pattern: str) -> "QueryBuilder":
        self._params["regex"] = pattern
        return self

    def cas(self, cas: str) -> "QueryBuilder":
        self._params["cas"] = cas
        return self

    def origin(self, origin: str) -> "QueryBuilder":
        self._params["origin"] = origin
        return self

    def role(self, role: str) -> "QueryBuilder":
        self._params["role"] = role
        return self

    def cls(self, cls_name: str) -> "QueryBuilder":
        self._params["cls"] = cls_name
        return self

    def doi(self, doi: str) -> "QueryBuilder":
        self._params["doi"] = doi
        return self

    def et_between(self, min_val: float | None = None, max_val: float | None = None, *, unit: str = "kcal") -> "QueryBuilder":
        self._params["et_min"] = min_val
        self._params["et_max"] = max_val
        self._params["et_unit"] = unit
        return self

    def min_score(self, score: int) -> "QueryBuilder":
        self._params["min_score"] = score
        return self

    def verify_level(self, level: str) -> "QueryBuilder":
        self._params["verify_level"] = level
        return self

    def has_cas(self, flag: bool = True) -> "QueryBuilder":
        self._params["has_cas"] = flag
        return self

    def has_uv(self, flag: bool = True) -> "QueryBuilder":
        self._params["has_uv"] = flag
        return self

    def exact(self, smiles: str) -> "QueryBuilder":
        self._params["exact_smiles"] = smiles
        return self

    def substructure(self, query: str, *, smarts: bool = False) -> "QueryBuilder":
        self._params["substructure"] = query
        self._params["smarts"] = smarts
        return self

    def similarity(self, smiles: str, *, threshold: float = 0.5) -> "QueryBuilder":
        self._params["similarity_smiles"] = smiles
        self._params["similarity_threshold"] = threshold
        return self

    def sort_by(self, mode: str) -> "QueryBuilder":
        self._params["sort_by"] = mode
        return self

    def limit(self, n: int) -> "QueryBuilder":
        self._params["limit"] = n
        return self

    def execute(self) -> SearchResult:
        entries = self._client.fetch_entries()
        return filter_entries(entries, **self._params)

    def all(self) -> list[Entry]:
        return self.execute().entries

    def first(self) -> Entry | None:
        res = self.limit(1).execute().entries
        return res[0] if res else None

    def count(self) -> int:
        return len(self.execute())

    def group_by_molecule(self) -> list[MoleculeGroup]:
        return self.execute().group_by_molecule()

    def to_dicts(self) -> list[dict[str, Any]]:
        return self.execute().to_dicts()

    def to_dataframe(self) -> "pd.DataFrame":
        return self.execute().to_dataframe()

    def to_csv(self, path: str | Path) -> Path:
        return self.execute().to_csv(path)

    def to_json(self, path: str | Path) -> Path:
        return self.execute().to_json(path)

    def to_sdf(self, path: str | Path) -> int:
        return self.execute().to_sdf(path)

    def stats(self, *, top_n: int = 10) -> Any:
        return self.execute().stats(top_n=top_n)

    def exp_vs_calc(self) -> Any:
        return self.execute().exp_vs_calc()

    def molecule_spread(self, *, origin: str | None = None, min_count: int = 2) -> list[Any]:
        return self.execute().molecule_spread(origin=origin, min_count=min_count)

    def descriptors(self) -> list[dict[str, Any]]:
        return self.execute().descriptors()
