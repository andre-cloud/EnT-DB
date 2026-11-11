"""Statistical analyses for TrEnDB entries (pure Python with optional Pandas export)."""

from __future__ import annotations

import json
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from . import chem
from .models import Entry
from .query import group_by_molecule
from .scoring import clean_doi, grade_of

if TYPE_CHECKING:
    import pandas as pd


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0.0 or dy == 0.0:
        return None
    return num / (dx * dy)


@dataclass
class NumericStats:
    count: int
    mean: float
    std: float
    median: float
    q25: float
    q75: float
    iqr: float
    min: float
    max: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_numbers(values: Iterable[float]) -> NumericStats | None:
    vals = sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not vals:
        return None
    q25 = _percentile(vals, 0.25)
    q75 = _percentile(vals, 0.75)
    return NumericStats(
        count=len(vals),
        mean=round(statistics.fmean(vals), 3),
        std=round(statistics.stdev(vals), 3) if len(vals) >= 2 else 0.0,
        median=round(statistics.median(vals), 3),
        q25=round(q25, 3),
        q75=round(q75, 3),
        iqr=round(q75 - q25, 3),
        min=round(vals[0], 3),
        max=round(vals[-1], 3),
    )


@dataclass
class ExpCalcPair:
    name: str
    cas: str | None
    smiles: str
    cls: str | None
    n_exp: int
    n_calc: int
    et_exp_mean: float
    et_calc_mean: float
    diff_calc_minus_exp: float
    abs_diff: float
    exp_methods: list[str]
    calc_methods: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExpCalcSummary:
    n_molecules: int
    mae: float | None
    rmse: float | None
    bias: float | None
    max_abs_error: float | None
    pearson_r: float | None
    r2: float | None
    pairs: list[ExpCalcPair]

    def to_dicts(self) -> list[dict[str, Any]]:
        return [p.to_dict() for p in self.pairs]

    def to_dataframe(self) -> "pd.DataFrame":
        try:
            import pandas as pd
        except ImportError as exc:  # pragma: no cover
            raise ImportError("pandas is required for to_dataframe().") from exc
        return pd.DataFrame(self.to_dicts())

    def to_markdown(self) -> str:
        if not self.n_molecules:
            return "No molecules have both experimental and computed E_T values."
        lines = [
            f"### Experimental vs Computed E_T ({self.n_molecules} paired molecules)",
            "",
            f"- **MAE**: {self.mae:.2f} kcal/mol",
            f"- **RMSE**: {self.rmse:.2f} kcal/mol",
            f"- **Bias (calc - exp)**: {self.bias:+.2f} kcal/mol",
            f"- **Max |error|**: {self.max_abs_error:.2f} kcal/mol",
            f"- **Pearson r / R²**: {self.pearson_r:.4f} / {self.r2:.4f}" if self.pearson_r is not None else "- **Pearson r**: n/a",
            "",
            "| Molecule | Exp mean | Calc mean | Δ(calc-exp) |",
            "| --- | ---: | ---: | ---: |",
        ]
        for p in sorted(self.pairs, key=lambda x: x.abs_diff, reverse=True)[:15]:
            lines.append(
                f"| {p.name} | {p.et_exp_mean:.1f} | {p.et_calc_mean:.1f} | {p.diff_calc_minus_exp:+.1f} |"
            )
        return "\n".join(lines)


@dataclass
class MoleculeSpread:
    name: str
    cas: str | None
    smiles: str
    origin: str
    count: int
    n_dois: int
    et_min: float
    et_max: float
    et_span: float
    et_mean: float
    et_std: float
    dois: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def compare_exp_calc(entries: Iterable[Entry]) -> ExpCalcSummary:
    """Benchmark computed vs experimental E_T across molecules having both origins."""
    pairs: list[ExpCalcPair] = []
    for grp in group_by_molecule(entries):
        exps = [e for e in grp.entries if e.origin == "exp" and math.isfinite(e.et_kcal)]
        calcs = [e for e in grp.entries if e.origin == "calc" and math.isfinite(e.et_kcal)]
        if not exps or not calcs:
            continue
        exp_mean = statistics.fmean(e.et_kcal for e in exps)
        calc_mean = statistics.fmean(e.et_kcal for e in calcs)
        diff = calc_mean - exp_mean
        pairs.append(
            ExpCalcPair(
                name=grp.name,
                cas=grp.cas,
                smiles=grp.smiles,
                cls=next((e.cls for e in grp.entries if e.cls), None),
                n_exp=len(exps),
                n_calc=len(calcs),
                et_exp_mean=round(exp_mean, 3),
                et_calc_mean=round(calc_mean, 3),
                diff_calc_minus_exp=round(diff, 3),
                abs_diff=round(abs(diff), 3),
                exp_methods=sorted({e.method for e in exps if e.method}),
                calc_methods=sorted({e.method for e in calcs if e.method}),
            )
        )

    if not pairs:
        return ExpCalcSummary(0, None, None, None, None, None, None, [])

    diffs = [p.diff_calc_minus_exp for p in pairs]
    abs_diffs = [p.abs_diff for p in pairs]
    xs = [p.et_exp_mean for p in pairs]
    ys = [p.et_calc_mean for p in pairs]
    r = _pearson(xs, ys)
    return ExpCalcSummary(
        n_molecules=len(pairs),
        mae=round(statistics.fmean(abs_diffs), 3),
        rmse=round(math.sqrt(statistics.fmean(d * d for d in diffs)), 3),
        bias=round(statistics.fmean(diffs), 3),
        max_abs_error=round(max(abs_diffs), 3),
        pearson_r=round(r, 4) if r is not None else None,
        r2=round(r * r, 4) if r is not None else None,
        pairs=pairs,
    )


def molecule_spread(
    entries: Iterable[Entry],
    *,
    origin: str | None = None,
    min_count: int = 2,
) -> list[MoleculeSpread]:
    """Measure literature E_T scatter for molecules with multiple entries."""
    out: list[MoleculeSpread] = []
    for grp in group_by_molecule(entries):
        by_orig: dict[str, list[Entry]] = defaultdict(list)
        for e in grp.entries:
            if origin and e.origin != origin:
                continue
            if math.isfinite(e.et_kcal):
                by_orig[e.origin].append(e)
        for orig, items in by_orig.items():
            if len(items) < min_count:
                continue
            vals = [e.et_kcal for e in items]
            dois = sorted({clean_doi(e.doi) for e in items if e.doi})
            lo, hi = min(vals), max(vals)
            out.append(
                MoleculeSpread(
                    name=grp.name,
                    cas=grp.cas,
                    smiles=grp.smiles,
                    origin=orig,
                    count=len(items),
                    n_dois=len(dois),
                    et_min=round(lo, 2),
                    et_max=round(hi, 2),
                    et_span=round(hi - lo, 2),
                    et_mean=round(statistics.fmean(vals), 2),
                    et_std=round(statistics.stdev(vals), 2) if len(vals) >= 2 else 0.0,
                    dois=dois,
                )
            )
    out.sort(key=lambda x: (x.et_span, x.count), reverse=True)
    return out


def et_histogram(
    entries: Iterable[Entry],
    *,
    bins: int = 8,
    et_min: float | None = None,
    et_max: float | None = None,
) -> list[dict[str, Any]]:
    """Compute binned E_T distribution across entries."""
    vals = [e.et_kcal for e in entries if math.isfinite(e.et_kcal)]
    if not vals:
        return []
    lo = float(et_min) if et_min is not None else math.floor(min(vals))
    hi = float(et_max) if et_max is not None else math.ceil(max(vals))
    if hi <= lo:
        hi = lo + 1.0
    width = (hi - lo) / max(1, bins)
    counts = [0] * max(1, bins)
    for v in vals:
        if v < lo or v > hi:
            continue
        idx = min(len(counts) - 1, int((v - lo) / width))
        counts[idx] += 1
    out = []
    for i, c in enumerate(counts):
        a = lo + i * width
        b = a + width
        out.append({"bin_start": round(a, 2), "bin_end": round(b, 2), "count": c})
    return out


def compute_descriptors(entries: Iterable[Entry]) -> list[dict[str, Any]]:
    """Enrich entries with RDKit molecular descriptors for structure-property statistics."""
    chem.require_rdkit()
    rows: list[dict[str, Any]] = []
    for e in entries:
        desc = chem.molecular_descriptors(e.smiles)
        if desc is None:
            continue
        rows.append(
            {
                "id": e.id,
                "name": e.name,
                "cas": e.cas,
                "smiles": e.smiles,
                "cls": e.cls,
                "role": e.role,
                "origin": e.origin,
                "et_kcal": e.et_kcal,
                "et_kj": round(e.et_kj, 2) if math.isfinite(e.et_kcal) else None,
                "et_ev": round(e.et_ev, 4) if math.isfinite(e.et_kcal) else None,
                "uv_lmax": e.uv_lmax,
                "uv_eps": e.uv_eps,
                "uv_cond": e.uv_cond,
                "direct_exc": e.direct_exc,
                "doi": e.doi,
                "score": e.score,
                **desc,
            }
        )
    return rows


@dataclass
class DatabaseStats:
    total_entries: int
    unique_molecules: int
    unique_dois: int
    by_origin: dict[str, int]
    by_role: dict[str, int]
    by_class: dict[str, int]
    by_verify_level: dict[str, int]
    score_grades: dict[str, int]
    completeness: dict[str, dict[str, Any]]
    et_overall: NumericStats | None
    et_by_origin: dict[str, NumericStats]
    et_by_role: dict[str, NumericStats]
    et_by_class: dict[str, NumericStats]
    score_stats: NumericStats | None
    top_dois: list[dict[str, Any]]
    histogram: list[dict[str, Any]]
    exp_calc: ExpCalcSummary
    spread: list[MoleculeSpread]

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_entries": self.total_entries,
            "unique_molecules": self.unique_molecules,
            "unique_dois": self.unique_dois,
            "by_origin": self.by_origin,
            "by_role": self.by_role,
            "by_class": self.by_class,
            "by_verify_level": self.by_verify_level,
            "score_grades": self.score_grades,
            "completeness": self.completeness,
            "et_overall": self.et_overall.to_dict() if self.et_overall else None,
            "et_by_origin": {k: v.to_dict() for k, v in self.et_by_origin.items()},
            "et_by_role": {k: v.to_dict() for k, v in self.et_by_role.items()},
            "et_by_class": {k: v.to_dict() for k, v in self.et_by_class.items()},
            "score_stats": self.score_stats.to_dict() if self.score_stats else None,
            "top_dois": self.top_dois,
            "histogram": self.histogram,
            "exp_calc": {
                "n_molecules": self.exp_calc.n_molecules,
                "mae": self.exp_calc.mae,
                "rmse": self.exp_calc.rmse,
                "bias": self.exp_calc.bias,
                "max_abs_error": self.exp_calc.max_abs_error,
                "pearson_r": self.exp_calc.pearson_r,
                "r2": self.exp_calc.r2,
                "pairs": self.exp_calc.to_dicts(),
            },
            "spread": [s.to_dict() for s in self.spread],
        }

    def to_json(self, path: str | Path, *, indent: int = 2) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.to_dict(), indent=indent, ensure_ascii=False), encoding="utf-8")
        return out

    def to_class_dataframe(self) -> "pd.DataFrame":
        try:
            import pandas as pd
        except ImportError as exc:  # pragma: no cover
            raise ImportError("pandas is required for to_class_dataframe().") from exc
        rows = [{"cls": cls_name, **st.to_dict()} for cls_name, st in self.et_by_class.items()]
        return pd.DataFrame(rows)

    def to_markdown(self) -> str:
        lines = [
            "# TrEnDB Statistical Summary",
            "",
            f"- **Total entries**: {self.total_entries}",
            f"- **Unique molecules**: {self.unique_molecules}",
            f"- **Distinct DOIs**: {self.unique_dois}",
            f"- **Origins**: {self.by_origin}",
            f"- **Roles**: {self.by_role}",
            f"- **Score grades**: {self.score_grades}",
        ]
        if self.et_overall:
            s = self.et_overall
            lines.append(
                f"- **E_T overall (kcal/mol)**: mean={s.mean:.2f}, std={s.std:.2f}, "
                f"median={s.median:.2f} (IQR {s.iqr:.2f}), range=[{s.min:.1f}, {s.max:.1f}]"
            )
        if self.et_by_origin:
            lines.extend(["", "## E_T by Origin (kcal/mol)", "", "| Origin | N | Mean | Std | Median | Min | Max |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"])
            for orig, st in self.et_by_origin.items():
                lines.append(f"| {orig} | {st.count} | {st.mean:.2f} | {st.std:.2f} | {st.median:.2f} | {st.min:.1f} | {st.max:.1f} |")
        if self.et_by_class:
            lines.extend(["", "## Top Classes", "", "| Class | N | Mean E_T | Median E_T | Range |", "| --- | ---: | ---: | ---: | --- |"])
            for cls_name, st in sorted(self.et_by_class.items(), key=lambda kv: kv[1].count, reverse=True)[:15]:
                lines.append(f"| {cls_name} | {st.count} | {st.mean:.2f} | {st.median:.2f} | {st.min:.1f}–{st.max:.1f} |")
        if self.completeness:
            lines.extend(["", "## Metadata Completeness", "", "| Field | Present | % |", "| --- | ---: | ---: |"])
            for field, info in self.completeness.items():
                lines.append(f"| {field} | {info['count']} | {info['pct']:.1f}% |")
        if self.exp_calc.n_molecules:
            lines.extend(["", self.exp_calc.to_markdown()])
        if self.spread:
            lines.extend(["", "## Largest Multi-Entry Spreads (same origin)", "", "| Molecule | Origin | N | DOIs | Span | Range |", "| --- | --- | ---: | ---: | ---: | --- |"])
            for sp in self.spread[:10]:
                lines.append(f"| {sp.name} | {sp.origin} | {sp.count} | {sp.n_dois} | {sp.et_span:.1f} | {sp.et_min:.1f}–{sp.et_max:.1f} |")
        return "\n".join(lines) + "\n"


def analyze_entries(entries: Iterable[Entry], *, top_n: int = 10) -> DatabaseStats:
    """Compute comprehensive descriptive, consistency, and exp-vs-calc statistics."""
    rows = list(entries)
    groups = group_by_molecule(rows)

    by_origin = dict(Counter(e.origin for e in rows))
    by_role = dict(Counter(e.role for e in rows))
    by_class = dict(Counter((e.cls or "(unclassified)") for e in rows).most_common())
    by_verify = dict(Counter((e.verify_level or "(unspecified)") for e in rows))

    grades: Counter[str] = Counter()
    scores: list[float] = []
    for e in rows:
        if e.score is not None:
            scores.append(float(e.score))
            grades[grade_of(int(e.score))["label"]] += 1

    dois = [clean_doi(e.doi) for e in rows if e.doi]
    doi_counts = Counter(dois)
    top_dois = [{"doi": d, "count": c} for d, c in doi_counts.most_common(top_n)]

    n_total = len(rows)
    completeness: dict[str, dict[str, Any]] = {}
    for fname in ("cas", "doi", "citation", "location", "quote", "uv_lmax", "uv_eps", "uv_cond", "direct_exc", "et_unc", "cls"):
        present = sum(1 for e in rows if getattr(e, fname) not in (None, "", []))
        pct = round((100.0 * present / n_total), 1) if n_total else 0.0
        completeness[fname] = {"count": present, "pct": pct}

    et_by_origin: dict[str, NumericStats] = {}
    for orig in sorted(by_origin):
        st = summarize_numbers(e.et_kcal for e in rows if e.origin == orig)
        if st:
            et_by_origin[orig] = st

    et_by_role: dict[str, NumericStats] = {}
    for role in sorted(by_role):
        st = summarize_numbers(e.et_kcal for e in rows if e.role == role)
        if st:
            et_by_role[role] = st

    et_by_class: dict[str, NumericStats] = {}
    for cls_name in by_class:
        st = summarize_numbers(e.et_kcal for e in rows if (e.cls or "(unclassified)") == cls_name)
        if st:
            et_by_class[cls_name] = st

    return DatabaseStats(
        total_entries=n_total,
        unique_molecules=len(groups),
        unique_dois=len(doi_counts),
        by_origin=by_origin,
        by_role=by_role,
        by_class=by_class,
        by_verify_level=by_verify,
        score_grades=dict(grades),
        completeness=completeness,
        et_overall=summarize_numbers(e.et_kcal for e in rows),
        et_by_origin=et_by_origin,
        et_by_role=et_by_role,
        et_by_class=et_by_class,
        score_stats=summarize_numbers(scores),
        top_dois=top_dois,
        histogram=et_histogram(rows),
        exp_calc=compare_exp_calc(rows),
        spread=molecule_spread(rows),
    )
