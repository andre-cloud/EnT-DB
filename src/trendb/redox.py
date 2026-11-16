"""Redox potentials (table redox_entries): filtering, grouping and representative values.

Mirrors the browser: values are compared against SCE (``e_sce``) and can be shown against any
reference of ``scoring.REF_TABLE``; the representative value of a molecule is the mean of its
experimental values, or of its computed ones when none was measured.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Any, Iterable

from .models import RedoxEntry
from .query import group_by_molecule
from .scoring import clean_cas, from_sce, to_sce
from .stats import ExpCalcSummary, compare_exp_calc

QUANTITIES = ("e_red", "e_ox", "e_star_red", "e_star_ox")


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
    sort_by: str = "added",
) -> list[RedoxEntry]:
    """Filter redox rows. ``e_min``/``e_max`` are in V against ``ref`` (default SCE)."""
    lo = to_sce(e_min, ref, solvent) if e_min is not None else None
    hi = to_sce(e_max, ref, solvent) if e_max is not None else None
    needle = (q or "").strip().lower()
    cas_p = clean_cas(cas) if cas else ""
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
        if doi and (r.doi or "").lower() != doi.lower():
            continue
        if cas_p and not (r.cas or "").startswith(cas_p):
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
        out.append(r)
    if sort_by in ("e_asc", "e_desc"):
        known = [r for r in out if r.e_sce is not None]
        rest = [r for r in out if r.e_sce is None]
        known.sort(key=lambda r: r.e_sce, reverse=sort_by == "e_desc")  # type: ignore[arg-type,return-value]
        out = known + rest
    return out


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


@dataclass
class RedoxMolecule:
    key: str
    name: str
    commercial_name: str | None
    cas: str | None
    smiles: str
    rows: list[RedoxEntry]

    @property
    def display_name(self) -> str:
        return self.commercial_name or self.name

    def value(self, quantity: str, ref: str = "SCE", solvent: str | None = None) -> float | None:
        rv = rep_value(self.rows, quantity)
        if rv is None:
            return None
        v = from_sce(rv.mean, ref, solvent)
        return None if math.isnan(v) else v


def group_redox_by_molecule(rows: Iterable[RedoxEntry]) -> list[RedoxMolecule]:
    """One record per molecule, with the same keys as the triplet-energy grouping (CAS, structure, SMILES)."""
    out: list[RedoxMolecule] = []
    for g in group_by_molecule(rows):  # duck-typed: needs cas, smiles, idcode, name, commercial_name
        key = f"cas:{g.cas}" if g.cas else f"smi:{g.smiles}"
        out.append(RedoxMolecule(key, g.name, g.commercial_name, g.cas, g.smiles, list(g.entries)))
    return out


def compare_exp_calc_redox(rows: Iterable[RedoxEntry], quantity: str = "e_red") -> ExpCalcSummary:
    """Computed vs experimental potentials (V vs SCE) for one quantity across molecules having both."""
    sel = [r for r in rows if r.quantity == quantity and r.e_sce is not None]
    return compare_exp_calc(sel, value=lambda r: r.e_sce)
