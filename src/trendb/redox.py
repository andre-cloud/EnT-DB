"""Redox potentials (table redox_entries): filtering, grouping, representative values, exports, statistics.

Mirrors the browser: values are compared against SCE (``e_sce``) and can be shown against any
reference of ``scoring.REF_TABLE``; the representative value of a molecule is the mean of its
experimental values, or of its computed ones when none was measured.
"""

from __future__ import annotations

import csv
import json
import math
import statistics
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from . import chem
from .models import KCAL_PER_EV, Entry, RedoxEntry
from .query import group_by_molecule
from .scoring import clean_cas, clean_doi, from_sce, to_sce
from .stats import ExpCalcSummary, NumericStats, compare_exp_calc, summarize_numbers

if TYPE_CHECKING:
    import pandas as pd

QUANTITIES = ("e_red", "e_ox", "e_star_red", "e_star_ox")
QUANTITY_NAMES = {
    "e_red": "E_red (PC/PC•−)",
    "e_ox": "E_ox (PC•+/PC)",
    "e_star_red": "E*_red (PC*/PC•−)",
    "e_star_ox": "E*_ox (PC•+/PC*)",
}
SORT_MODES = ("added", "e_asc", "e_desc", "score_desc", "similarity")


def _num(v: float | None) -> float | None:
    return None if v is None or math.isnan(v) else v


def filter_redox(
    rows: Iterable[RedoxEntry],
    *,
    q: str | None = None,
    cas: str | None = None,
    quantity: str | None = None,
    kind: str | None = None,
    state: str | None = None,
    origin: str | None = None,
    category: str | None = None,
    cls: str | None = None,
    doi: str | None = None,
    e_min: float | None = None,
    e_max: float | None = None,
    ref: str = "SCE",
    solvent: str | None = None,
    in_solvent: str | None = None,
    reported_ref: str | None = None,
    excited_from: str | None = None,
    min_score: int | None = None,
    exact_smiles: str | None = None,
    substructure: str | None = None,
    smarts: bool = False,
    similarity_smiles: str | None = None,
    similarity_threshold: float = 0.5,
    sort_by: str = "added",
    limit: int | None = None,
) -> "RedoxResult":
    """Filter redox rows.

    ``e_min``/``e_max`` are in V against ``ref`` (default SCE; ``solvent`` picks the Fc+/Fc offset).
    ``in_solvent`` keeps values measured in that solvent (case-insensitive substring), ``reported_ref``
    those reported against that electrode, ``excited_from`` ("measured" | "estimated") the excited-state
    values by how they were obtained. Structure filters need RDKit. ``sort_by``: added, e_asc, e_desc,
    score_desc, similarity.
    """
    if sort_by not in SORT_MODES:
        raise ValueError(f"sort_by must be one of {SORT_MODES}, not {sort_by!r}")
    if quantity and quantity not in QUANTITIES:
        raise ValueError(f"quantity must be one of {QUANTITIES}, not {quantity!r}")
    lo = to_sce(e_min, ref, solvent) if e_min is not None else None
    hi = to_sce(e_max, ref, solvent) if e_max is not None else None
    needle = (q or "").strip().lower()
    cas_p = clean_cas(cas) if cas else ""
    doi_p = clean_doi(doi).lower() if doi else ""
    solv_p = (in_solvent or "").strip().lower()
    if exact_smiles or substructure or similarity_smiles:
        chem.require_rdkit()
    sims: dict[int, float] = {}
    out: list[RedoxEntry] = []
    for r in rows:
        if quantity and r.quantity != quantity:
            continue
        if kind and r.kind != kind:
            continue
        if state and r.state != state:
            continue
        if origin and r.origin != origin:
            continue
        if category and r.category != category:
            continue
        if cls and (r.cls or "").lower() != cls.lower():
            continue
        if doi_p and clean_doi(r.doi or "").lower() != doi_p:
            continue
        if cas_p and not (r.cas or "").startswith(cas_p):
            continue
        if solv_p and solv_p not in (r.solvent or "").lower():
            continue
        if reported_ref and r.e_ref != reported_ref:
            continue
        if excited_from and (r.excited_from or "") != excited_from:
            continue
        if min_score is not None and (r.score is None or r.score < min_score):
            continue
        if needle:
            hay = " ".join(
                x or "" for x in (r.name, r.commercial_name, r.cas, r.smiles, r.cls, r.citation, r.doi, r.method, r.activated_group)
            ).lower()
            if needle not in hay:
                continue
        if lo is not None or hi is not None:
            if r.e_sce is None:
                continue
            if lo is not None and not math.isnan(lo) and r.e_sce < lo:
                continue
            if hi is not None and not math.isnan(hi) and r.e_sce > hi:
                continue
        if exact_smiles and not chem.exact_match(exact_smiles, r.smiles):
            continue
        if substructure and not chem.substructure_match(substructure, r.smiles, smarts=smarts):
            continue
        if similarity_smiles:
            sim = chem.tanimoto_similarity(similarity_smiles, r.smiles)
            if sim is None or sim < similarity_threshold:
                continue
            sims[id(r)] = round(sim, 4)
        out.append(r)
    if sort_by in ("e_asc", "e_desc"):
        known = [r for r in out if r.e_sce is not None]
        rest = [r for r in out if r.e_sce is None]
        known.sort(key=lambda r: r.e_sce, reverse=sort_by == "e_desc")  # type: ignore[arg-type,return-value]
        out = known + rest
    elif sort_by == "score_desc":
        out.sort(key=lambda r: -(r.score or 0))
    elif sort_by == "similarity" or (similarity_smiles and sort_by == "added"):
        out.sort(key=lambda r: sims.get(id(r), 0.0), reverse=True)
    if limit is not None:
        out = out[:limit]
    return RedoxResult(out, similarity={i: sims[id(r)] for i, r in enumerate(out) if id(r) in sims})


# ---------------- representative values and molecules ----------------


@dataclass
class RepValue:
    """Representative value of one quantity for one molecule (V vs SCE)."""

    mean: float
    sd: float | None
    n: int
    lo: float
    hi: float
    origin: str  # "exp" or "calc": which values were averaged


def rep_value(rows: Iterable[RedoxEntry], quantity: str) -> RepValue | None:
    """Mean of the experimental values of ``quantity`` (vs SCE), else of the computed ones."""
    sel = [r for r in rows if r.quantity == quantity and r.e_sce is not None]
    for origin in ("exp", "calc"):
        vals = [float(r.e_sce) for r in sel if r.origin == origin]  # type: ignore[arg-type]
        if vals:
            sd = statistics.stdev(vals) if len(vals) > 1 else None
            return RepValue(round(statistics.fmean(vals), 3), round(sd, 3) if sd is not None else None, len(vals), min(vals), max(vals), origin)
    return None


def _first(rows: Iterable[Any], attr: str) -> Any:
    for r in rows:
        v = getattr(r, attr, None)
        if v is not None and v != "":
            return v
    return None


@dataclass
class RedoxMolecule:
    """One molecule with its redox rows (and, when grouped with them, its triplet-energy entries).

    Potentials are representative values vs SCE (``rep_value``); ``value()`` shows them against
    another reference. Same record as PhotoTool's catalogue.
    """

    key: str
    name: str
    commercial_name: str | None
    cas: str | None
    smiles: str
    rows: list[RedoxEntry]
    et_entries: list[Entry] = field(default_factory=list)

    @property
    def display_name(self) -> str:
        return self.commercial_name or self.name

    def rep(self, quantity: str) -> RepValue | None:
        return rep_value(self.rows, quantity)

    def value(self, quantity: str, ref: str = "SCE", solvent: str | None = None) -> float | None:
        rv = self.rep(quantity)
        return None if rv is None else _num(from_sce(rv.mean, ref, solvent))

    def _mean(self, quantity: str) -> float | None:
        rv = self.rep(quantity)
        return rv.mean if rv else None

    @property
    def e_ox(self) -> float | None:
        """E(PC•+/PC), V vs SCE."""
        return self._mean("e_ox")

    @property
    def e_red(self) -> float | None:
        """E(PC/PC•−), V vs SCE."""
        return self._mean("e_red")

    @property
    def e_star_ox(self) -> float | None:
        """E(PC•+/PC*), V vs SCE."""
        return self._mean("e_star_ox")

    @property
    def e_star_red(self) -> float | None:
        """E(PC*/PC•−), V vs SCE."""
        return self._mean("e_star_red")

    @property
    def e00(self) -> float | None:
        """Mean E0,0 (eV) of the excited-state rows that report one."""
        vals = [r.e00_ev for r in self.rows if r.e00_ev is not None]
        return statistics.fmean(vals) if vals else None

    @property
    def et_ev(self) -> float | None:
        """Mean experimental triplet energy (eV) from TrEnDB, when grouped with ``et_entries``."""
        vals = [e.et_kcal for e in self.et_entries if e.origin != "calc" and math.isfinite(e.et_kcal)]
        return round(statistics.fmean(vals) / KCAL_PER_EV, 2) if vals else None

    @property
    def cls(self) -> str | None:
        return _first([*self.rows, *self.et_entries], "cls")

    @property
    def category(self) -> str | None:
        return _first(self.rows, "category")

    @property
    def activated_group(self) -> str | None:
        return _first(self.rows, "activated_group")

    @property
    def tau_ns(self) -> float | None:
        return _first(self.rows, "tau_ns")

    @property
    def uv_lmax(self) -> int | None:
        return _first([*self.rows, *self.et_entries], "uv_lmax")

    @property
    def excited_state(self) -> str | None:
        return next((r.state for r in self.rows if r.state and r.state != "S0"), None)

    @property
    def is_photocatalyst(self) -> bool:
        """Category photocatalyst, or no category but an excited-state potential (as PhotoTool)."""
        return self.category == "photocatalyst" or (not self.category and (self.e_star_ox is not None or self.e_star_red is not None))

    @property
    def dois(self) -> list[str]:
        return sorted({r.doi for r in self.rows if r.doi})

    def to_dict(self, ref: str = "SCE", solvent: str | None = None) -> dict[str, Any]:
        """Flat record: identity, the four potentials vs ``ref`` with origin and count, E0,0, photophysics."""
        d: dict[str, Any] = {
            "key": self.key,
            "name": self.display_name,
            "cas": self.cas,
            "smiles": self.smiles,
            "cls": self.cls,
            "category": self.category,
            "is_photocatalyst": self.is_photocatalyst,
            "ref": ref,
        }
        for q in QUANTITIES:
            rv = self.rep(q)
            d[q] = None if rv is None else _num(from_sce(rv.mean, ref, solvent))
            d[f"{q}_origin"] = rv.origin if rv else None
            d[f"{q}_n"] = rv.n if rv else 0
        d.update(
            e00_ev=self.e00,
            et_ev=self.et_ev,
            excited_state=self.excited_state,
            tau_ns=self.tau_ns,
            uv_lmax=self.uv_lmax,
            activated_group=self.activated_group,
            n_values=len(self.rows),
            dois=";".join(self.dois),
        )
        return d


def group_redox_by_molecule(rows: Iterable[RedoxEntry], et_entries: Iterable[Entry] | None = None) -> list[RedoxMolecule]:
    """One record per molecule, with the same keys as the triplet-energy grouping (CAS, structure, SMILES).

    With ``et_entries`` the triplet energies of the same molecules are attached (``RedoxMolecule.et_ev``);
    molecules without redox values are left out.
    """
    out: list[RedoxMolecule] = []
    mixed: list[Any] = [*rows, *(et_entries or [])]
    for g in group_by_molecule(mixed):  # duck-typed: needs cas, smiles, idcode, name, commercial_name
        rx = [x for x in g.entries if isinstance(x, RedoxEntry)]
        if not rx:
            continue
        et = [x for x in g.entries if isinstance(x, Entry)]
        key = f"cas:{g.cas}" if g.cas else f"smi:{rx[0].smiles}"
        named = next((x for x in g.entries if x.commercial_name), None)
        out.append(RedoxMolecule(key, rx[0].name, named.commercial_name if named else None, g.cas, rx[0].smiles, rx, et))
    return out


def photocatalysts(molecules: Iterable[RedoxMolecule]) -> list[RedoxMolecule]:
    """Photocatalysts with at least one excited-state potential (PhotoTool's list)."""
    return [m for m in molecules if m.is_photocatalyst and (m.e_star_ox is not None or m.e_star_red is not None)]


def substrates(molecules: Iterable[RedoxMolecule]) -> list[RedoxMolecule]:
    """Molecules that are not photocatalysts and have a ground-state potential."""
    return [m for m in molecules if not m.is_photocatalyst and (m.e_ox is not None or m.e_red is not None)]


def find_molecule(molecules: Iterable[RedoxMolecule], query: str) -> RedoxMolecule | None:
    """Molecule whose CAS, name or commercial name is ``query`` (case-insensitive), else the first containing it."""
    mols = list(molecules)
    ql = query.strip().lower()
    if not ql:
        return None
    cas_q = clean_cas(query)
    for m in mols:
        if (cas_q and m.cas == cas_q) or ql in ((m.name or "").lower(), (m.commercial_name or "").lower()):
            return m
    return next((m for m in mols if ql in f"{m.name} {m.commercial_name or ''}".lower()), None)


def compare_exp_calc_redox(rows: Iterable[RedoxEntry], quantity: str = "e_red") -> ExpCalcSummary:
    """Computed vs experimental potentials (V vs SCE) for one quantity across molecules having both."""
    sel = [r for r in rows if r.quantity == quantity and r.e_sce is not None]
    return compare_exp_calc(sel, value=lambda r: r.e_sce)


@dataclass
class RedoxSpread:
    """Scatter of the values of one quantity for one molecule (V vs SCE)."""

    name: str
    cas: str | None
    smiles: str
    quantity: str
    origin: str
    count: int
    e_min: float
    e_max: float
    span: float
    mean: float
    std: float
    dois: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def redox_spread(rows: Iterable[RedoxEntry], quantity: str, *, origin: str | None = None, min_count: int = 2) -> list[RedoxSpread]:
    """Molecules with several values of ``quantity`` (per origin), widest span first: where the literature disagrees."""
    sel = [r for r in rows if r.quantity == quantity and r.e_sce is not None and (origin is None or r.origin == origin)]
    out: list[RedoxSpread] = []
    for m in group_redox_by_molecule(sel):
        for orig in sorted({r.origin for r in m.rows}):
            items = [r for r in m.rows if r.origin == orig]
            if len(items) < min_count:
                continue
            vals = [float(r.e_sce) for r in items]  # type: ignore[arg-type]
            out.append(
                RedoxSpread(
                    name=m.display_name, cas=m.cas, smiles=m.smiles, quantity=quantity, origin=orig, count=len(vals),
                    e_min=round(min(vals), 3), e_max=round(max(vals), 3), span=round(max(vals) - min(vals), 3),
                    mean=round(statistics.fmean(vals), 3), std=round(statistics.stdev(vals), 3),
                    dois=sorted({clean_doi(r.doi) for r in items if r.doi}),
                )
            )
    out.sort(key=lambda s: (s.span, s.count), reverse=True)
    return out


# ---------------- statistics ----------------


@dataclass
class RedoxStats:
    """Overview of a set of redox values; potentials in V vs SCE."""

    total_values: int
    unique_molecules: int
    unique_dois: int
    by_quantity: dict[str, int]
    by_origin: dict[str, int]
    by_category: dict[str, int]
    by_reported_ref: dict[str, int]
    top_solvents: list[tuple[str, int]]
    not_convertible: int
    potentials: dict[str, NumericStats | None]
    top_classes: list[tuple[str, int]]
    photocatalysts: int
    substrates: int

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["potentials"] = {k: (v.to_dict() if v else None) for k, v in self.potentials.items()}
        return d

    def to_json(self, path: str | Path, *, indent: int = 2) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.to_dict(), indent=indent, ensure_ascii=False), encoding="utf-8")
        return out

    def to_markdown(self) -> str:
        lines = [
            "# Redox potentials",
            "",
            f"- Values: **{self.total_values}** ({self.not_convertible} not convertible to SCE)",
            f"- Molecules: **{self.unique_molecules}** ({self.photocatalysts} photocatalysts, {self.substrates} substrates)",
            f"- Sources (DOI): **{self.unique_dois}**",
            "",
            "| Quantity | n | mean | median | min | max | sd |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
        for q in QUANTITIES:
            s = self.potentials.get(q)
            if s:
                lines.append(f"| {QUANTITY_NAMES[q]} | {s.count} | {s.mean:+.2f} | {s.median:+.2f} | {s.min:+.2f} | {s.max:+.2f} | {s.std:.2f} |")
        lines += ["", "Potentials in V vs SCE.", "", "| Origin | n |", "| --- | ---: |"]
        lines += [f"| {k} | {v} |" for k, v in sorted(self.by_origin.items())]
        if self.top_classes:
            lines += ["", "| Class | n |", "| --- | ---: |"] + [f"| {k} | {v} |" for k, v in self.top_classes]
        return "\n".join(lines) + "\n"


def analyze_redox(rows: Iterable[RedoxEntry], *, top_n: int = 10) -> RedoxStats:
    """Counts, potential distributions per quantity (V vs SCE) and the molecule catalogue in numbers."""
    rows = list(rows)
    mols = group_redox_by_molecule(rows)
    return RedoxStats(
        total_values=len(rows),
        unique_molecules=len(mols),
        unique_dois=len({clean_doi(r.doi).lower() for r in rows if r.doi}),
        by_quantity=dict(Counter(r.quantity for r in rows)),
        by_origin=dict(Counter(r.origin for r in rows)),
        by_category=dict(Counter(r.category or "unassigned" for r in rows)),
        by_reported_ref=dict(Counter(r.e_ref for r in rows)),
        top_solvents=Counter(r.solvent for r in rows if r.solvent).most_common(top_n),
        not_convertible=sum(1 for r in rows if r.e_sce is None),
        potentials={q: summarize_numbers(float(r.e_sce) for r in rows if r.quantity == q and r.e_sce is not None) for q in QUANTITIES},  # type: ignore[arg-type]
        top_classes=Counter(m.cls for m in mols if m.cls).most_common(top_n),
        photocatalysts=len(photocatalysts(mols)),
        substrates=len(substrates(mols)),
    )


# ---------------- result set and query builder ----------------


def _sdf_props(r: RedoxEntry) -> dict[str, Any]:
    return {
        "name": r.display_name, "smiles": r.smiles, "cas": r.cas, "quantity": r.quantity, "kind": r.kind, "state": r.state,
        "origin": r.origin, "e_v": r.e_v, "e_ref": r.e_ref, "e_sce": r.e_sce, "e00_ev": r.e00_ev, "solvent": r.solvent,
        "category": r.category, "cls": r.cls, "doi": r.doi, "score": r.score, "id": r.id,
    }


class RedoxResult(list):  # a list, so code that iterated over search_redox() keeps working
    """Filtered redox values with export, grouping and statistics helpers."""

    def __init__(self, rows: Iterable[RedoxEntry] = (), similarity: dict[int, float] | None = None) -> None:
        super().__init__(rows)
        self.similarity = similarity or {}  # position -> Tanimoto similarity, after a similarity search

    def __repr__(self) -> str:
        return f"RedoxResult(count={len(self)})"

    def to_dicts(self, ref: str = "SCE", solvent: str | None = None) -> list[dict[str, Any]]:
        """Rows as dicts, plus ``quantity`` and the value against ``ref`` (``e_display``)."""
        out = []
        for i, r in enumerate(self):
            d = r.to_dict()
            d["quantity"] = r.quantity
            d["e_display"] = r.potential(ref, solvent)
            d["e_display_ref"] = ref
            if i in self.similarity:
                d["similarity"] = self.similarity[i]
            out.append(d)
        return out

    def to_json(self, path: str | Path, *, ref: str = "SCE", solvent: str | None = None, indent: int = 2) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.to_dicts(ref, solvent), indent=indent, ensure_ascii=False), encoding="utf-8")
        return out

    def to_csv(self, path: str | Path, *, ref: str = "SCE", solvent: str | None = None) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        rows = self.to_dicts(ref, solvent)
        keys: list[str] = []
        for r in rows:
            keys += [k for k in r if k not in keys]
        with out.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=keys)
            w.writeheader()
            for r in rows:
                w.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in r.items()})
        return out

    def to_dataframe(self, ref: str = "SCE", solvent: str | None = None) -> "pd.DataFrame":
        try:
            import pandas as pd
        except ImportError as exc:  # pragma: no cover
            raise ImportError("pandas is required for to_dataframe(). Install with `pip install trendb[data]`.") from exc
        return pd.DataFrame(self.to_dicts(ref, solvent))

    def to_sdf(self, path: str | Path) -> int:
        return chem.write_sdf(self, path, props=_sdf_props)

    def molecules(self, et_entries: Iterable[Entry] | None = None) -> list[RedoxMolecule]:
        return group_redox_by_molecule(self, et_entries)

    def molecule_table(self, ref: str = "SCE", solvent: str | None = None) -> list[dict[str, Any]]:
        """One flat record per molecule (``RedoxMolecule.to_dict``)."""
        return [m.to_dict(ref, solvent) for m in self.molecules()]

    def stats(self, *, top_n: int = 10) -> RedoxStats:
        return analyze_redox(self, top_n=top_n)

    def exp_vs_calc(self, quantity: str = "e_red") -> ExpCalcSummary:
        return compare_exp_calc_redox(self, quantity)

    def spread(self, quantity: str, *, origin: str | None = None, min_count: int = 2) -> list[RedoxSpread]:
        return redox_spread(self, quantity, origin=origin, min_count=min_count)


class RedoxQuery:
    """Fluent query over the redox potentials of a TrEnDBClient (``client.redox_query()``)."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._p: dict[str, Any] = {}

    def _set(self, **kw: Any) -> "RedoxQuery":
        self._p.update(kw)
        return self

    def text(self, q: str) -> "RedoxQuery":
        return self._set(q=q)

    def cas(self, cas: str) -> "RedoxQuery":
        return self._set(cas=cas)

    def quantity(self, quantity: str) -> "RedoxQuery":
        return self._set(quantity=quantity)

    def ground_state(self) -> "RedoxQuery":
        return self._set(state="S0")

    def excited_state(self, state: str) -> "RedoxQuery":
        return self._set(state=state)

    def reductions(self) -> "RedoxQuery":
        return self._set(kind="red")

    def oxidations(self) -> "RedoxQuery":
        return self._set(kind="ox")

    def origin(self, origin: str) -> "RedoxQuery":
        return self._set(origin=origin)

    def category(self, category: str) -> "RedoxQuery":
        return self._set(category=category)

    def photocatalysts(self) -> "RedoxQuery":
        return self._set(category="photocatalyst")

    def substrates(self) -> "RedoxQuery":
        return self._set(category="substrate")

    def cls(self, cls_name: str) -> "RedoxQuery":
        return self._set(cls=cls_name)

    def doi(self, doi: str) -> "RedoxQuery":
        return self._set(doi=doi)

    def between(self, e_min: float | None = None, e_max: float | None = None, *, ref: str = "SCE", solvent: str | None = None) -> "RedoxQuery":
        """Potential window in V against ``ref``."""
        return self._set(e_min=e_min, e_max=e_max, ref=ref, solvent=solvent)

    def in_solvent(self, solvent: str) -> "RedoxQuery":
        return self._set(in_solvent=solvent)

    def reported_against(self, ref: str) -> "RedoxQuery":
        return self._set(reported_ref=ref)

    def excited_from(self, how: str) -> "RedoxQuery":
        return self._set(excited_from=how)

    def min_score(self, score: int) -> "RedoxQuery":
        return self._set(min_score=score)

    def exact(self, smiles: str) -> "RedoxQuery":
        return self._set(exact_smiles=smiles)

    def substructure(self, query: str, *, smarts: bool = False) -> "RedoxQuery":
        return self._set(substructure=query, smarts=smarts)

    def similarity(self, smiles: str, *, threshold: float = 0.5) -> "RedoxQuery":
        return self._set(similarity_smiles=smiles, similarity_threshold=threshold)

    def sort_by(self, mode: str) -> "RedoxQuery":
        return self._set(sort_by=mode)

    def limit(self, n: int) -> "RedoxQuery":
        return self._set(limit=n)

    def execute(self) -> RedoxResult:
        return filter_redox(self._client.fetch_redox(), **self._p)

    def all(self) -> list[RedoxEntry]:
        return list(self.execute())

    def first(self) -> RedoxEntry | None:
        res = filter_redox(self._client.fetch_redox(), **{**self._p, "limit": 1})
        return res[0] if res else None

    def count(self) -> int:
        return len(self.execute())

    def molecules(self) -> list[RedoxMolecule]:
        return self.execute().molecules()

    def to_dicts(self, ref: str = "SCE", solvent: str | None = None) -> list[dict[str, Any]]:
        return self.execute().to_dicts(ref, solvent)

    def to_dataframe(self, ref: str = "SCE", solvent: str | None = None) -> "pd.DataFrame":
        return self.execute().to_dataframe(ref, solvent)

    def to_csv(self, path: str | Path, **kw: Any) -> Path:
        return self.execute().to_csv(path, **kw)

    def to_json(self, path: str | Path, **kw: Any) -> Path:
        return self.execute().to_json(path, **kw)

    def to_sdf(self, path: str | Path) -> int:
        return self.execute().to_sdf(path)

    def stats(self, *, top_n: int = 10) -> RedoxStats:
        return self.execute().stats(top_n=top_n)

    def exp_vs_calc(self, quantity: str = "e_red") -> ExpCalcSummary:
        return self.execute().exp_vs_calc(quantity)
