"""PhotoTool in Python: photoredox cycles, excited-state potentials, quenching ΔG and the reactivity advisor.

A port of the maths of ``docs/assets/redox.js`` (adapted there from RedoxDB by alebusso12, used with
permission); ``tests/test_photoredox.py`` checks it against the same cases as ``tools/test-redox.mjs``.
All potentials are V vs SCE and free energies are eV, as in the browser.

A photocatalyst is anything with the attributes (or mapping keys) ``e_ox``, ``e_red``, ``e_star_ox``,
``e_star_red``: a :class:`~trendb.redox.RedoxMolecule`, a dict, or :class:`Photocatalyst`.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .models import KCAL_PER_EV

GOOD = -0.05  # eV: every step at or below this is feasible
BORDER = 0.15  # eV: borderline up to this
SOFT_TOL = 0.5  # eV: tolerance for steps on estimated potentials ("soft")
OVERKILL = -0.8  # eV: a photochemical step this exergonic is "much stronger than needed"
HC_EV_NM = 1239.84
COULOMB_EV_A = 14.40  # e²/(4πε₀) in eV·Å
H, C, NA = 6.62607015e-34, 2.99792458e8, 6.02214076e23
KJ_PER_EV = 96.4853
CM1_PER_EV = 8065.544
VERDICTS = ("good", "border", "bad", "unknown")
_RANK = {v: i for i, v in enumerate(VERDICTS)}

# Dielectric constants used by the excited-state tool for the Coulomb term.
DIELECTRIC = {"MeCN": 37.5, "DMF": 36.7, "DMSO": 46.7, "CH2Cl2": 8.93, "MeOH": 32.7, "H2O": 78.4, "acetone": 20.7,
              "THF": 7.58, "DCE": 10.4, "toluene": 2.38, "benzene": 2.27}


def _get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    v = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else v


def _name(obj: Any, default: str = "") -> str:
    return str(getattr(obj, "display_name", None) or _get(obj, "name") or default)


# ---------------- data types ----------------


@dataclass
class Photocatalyst:
    """Custom photocatalyst potentials, V vs SCE."""

    e_ox: float | None = None
    e_red: float | None = None
    e_star_ox: float | None = None
    e_star_red: float | None = None
    name: str = "PC"
    uv_lmax: int | None = None
    tau_ns: float | None = None


@dataclass
class Partner:
    """Electron donor (``E_ox``) or acceptor (``E_red``) of a cycle, V vs SCE. ``soft``: an estimate."""

    name: str
    E_ox: float | None = None
    E_red: float | None = None
    soft: bool = False

    @classmethod
    def of(cls, obj: Any) -> "Partner | None":
        if obj is None or isinstance(obj, Partner):
            return obj
        return cls(str(_get(obj, "name") or ""), _get(obj, "E_ox"), _get(obj, "E_red"), bool(_get(obj, "soft")))


@dataclass
class Step:
    g: float | None  # ΔG, eV
    soft: bool
    label: str


@dataclass
class Cycle:
    """One full photoredox cycle: the photochemical step (``steps[0]``) and the turnover step."""

    mode: str  # "reductive" | "oxidative" quenching
    steps: list[Step]
    worst: float | None = None  # largest ΔG among steps on firm potentials
    soft_worst: float | None = None  # largest ΔG among steps on estimated potentials
    complete: bool = False
    ok: bool = False  # photochemical step and the step on the key substrate are both known
    verdict: str = "unknown"  # good | border | bad | unknown
    score: float = 9.0  # lower is better

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode, "verdict": self.verdict, "worst_dg_ev": self.worst, "complete": self.complete,
            "steps": [{"label": s.label, "dg_ev": s.g, "soft": s.soft} for s in self.steps],
        }


@dataclass
class Reaction:
    """A reaction type of the advisor's library (``docs/assets/redox-reactions.js``)."""

    id: str
    name: str
    donor: Partner
    acceptor: Partner
    key: str  # "donor" | "acceptor": the substrate to activate
    reported_quenching: str
    family: str = ""
    summary: str = ""
    typical_pc: list[str] = field(default_factory=list)
    doi: str | None = None
    citation: str | None = None
    notes: str | None = None
    pcet: bool = False

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Reaction":
        return cls(
            id=d["id"], name=d["name"], donor=Partner.of(d.get("donor") or {}) or Partner(""),
            acceptor=Partner.of(d.get("acceptor") or {}) or Partner(""), key=d["key"],
            reported_quenching=d["reported_quenching"], family=d.get("family", ""), summary=d.get("summary", ""),
            typical_pc=list(d.get("typical_pc") or []), doi=d.get("doi"), citation=d.get("citation"),
            notes=d.get("notes"), pcet=bool(d.get("pcet")),
        )


# ---------------- thermodynamics of a cycle ----------------


def cycles(pc: Any, donor: Any = None, acceptor: Any = None, key: str | None = None) -> list[Cycle]:
    """Both quenching cycles of ``pc`` with ``donor`` and ``acceptor``, best first.

    Reductive: PC* + D → PC•− + D•+ (ΔG = E_ox(D) − E*red), then PC•− + A → PC + A•− (ΔG = E_red(PC) − E_red(A)).
    Oxidative: PC* + A → PC•+ + A•− (ΔG = E*ox − E_red(A)), then PC•+ + D → PC + D•+ (ΔG = E_ox(D) − E_ox(PC)).
    ``key`` ("donor" | "acceptor") is the substrate whose step must be known for a verdict.
    """
    D, A = Partner.of(donor), Partner.of(acceptor)
    dE = D.E_ox if D else None
    aE = A.E_red if A else None
    e_ox, e_red, eso, esr = (_get(pc, k) for k in ("e_ox", "e_red", "e_star_ox", "e_star_red"))
    dn, an = (D.name if D else "donor"), (A.name if A else "acceptor")
    out: list[Cycle] = []
    if esr is not None:
        out.append(Cycle("reductive", [
            Step(dE - esr if dE is not None else None, bool(D and D.soft), f"PC* oxidises {dn}"),
            Step(e_red - aE if aE is not None and e_red is not None else None, bool(A and A.soft), f"PC•− reduces {an}"),
        ]))
    if eso is not None:
        out.append(Cycle("oxidative", [
            Step(eso - aE if aE is not None else None, bool(A and A.soft), f"PC* reduces {an}"),
            Step(dE - e_ox if dE is not None and e_ox is not None else None, bool(D and D.soft), f"PC•+ oxidises {dn}"),
        ]))
    for c in out:
        hard = [s.g for s in c.steps if s.g is not None and not s.soft]
        soft = [s.g for s in c.steps if s.g is not None and s.soft]
        c.worst = max(hard) if hard else None
        c.soft_worst = max(soft) if soft else None
        c.complete = all(s.g is not None for s in c.steps)
        if key == "donor":
            key_idx = 0 if c.mode == "reductive" else 1
        elif key == "acceptor":
            key_idx = 1 if c.mode == "reductive" else 0
        else:
            key_idx = 0
        c.ok = c.steps[0].g is not None and c.steps[key_idx].g is not None
        if c.worst is None:
            v = "border" if c.soft_worst is not None and c.soft_worst <= SOFT_TOL else "unknown"
        else:
            v = "good" if c.worst <= GOOD else "border" if c.worst <= BORDER else "bad"
        if v != "bad" and c.soft_worst is not None and c.soft_worst > SOFT_TOL:
            v = "border"
        if v == "good" and c.steps[0].soft:  # an estimated photochemical step cannot make a cycle feasible
            v = "border"
        c.verdict = v if c.ok else "unknown"
        c.score = c.worst if c.worst is not None else (c.soft_worst - 0.3 if c.soft_worst is not None else 9.0)
    return sorted(out, key=lambda c: c.score)


def best_cycle(pc: Any, donor: Any = None, acceptor: Any = None, reported: str | None = None, key: str | None = None) -> Cycle | None:
    """Better verdict, then a complete cycle, then a firm photochemical step, then the reported mechanism, then ΔG."""
    cs = [c for c in cycles(pc, donor, acceptor, key) if c.ok]
    cs.sort(key=lambda c: (_RANK[c.verdict], not c.complete, c.steps[0].soft, c.mode != reported, c.score))
    return cs[0] if cs else None


# ---------------- excited states, E0,0, quenching ----------------


def excited_potentials(e_ox: float | None, e_red: float | None, e00: float | None) -> tuple[float | None, float | None]:
    """(E*ox, E*red) = (E_ox − E0,0, E_red + E0,0), V; entropy and work terms neglected."""

    def ok(x: float | None) -> bool:
        return x is not None and math.isfinite(x)

    return (e_ox - e00 if ok(e_ox) and ok(e00) else None, e_red + e00 if ok(e_red) and ok(e00) else None)  # type: ignore[operator]


def e00_from(value: float | None, unit: str = "ev") -> float | None:
    """E0,0 in eV from eV, kcal/mol (e.g. a triplet energy), kJ/mol, cm⁻¹ or a wavelength in nm."""
    if value is None or not math.isfinite(value) or value <= 0:
        return None
    u = unit.lower()
    if u == "ev":
        return float(value)
    if u in ("kcal", "kcal/mol"):
        return value / KCAL_PER_EV
    if u in ("kj", "kj/mol"):
        return value / KJ_PER_EV
    if u in ("cm-1", "cm^-1", "wavenumber"):
        return value / CM1_PER_EV
    if u == "nm":
        return HC_EV_NM / value
    raise ValueError(f"Unsupported unit {unit!r}: use ev, kcal, kj, cm-1 or nm")


def coulomb(eps: float, r_angstrom: float) -> float:
    """Work term for two neutral partners forming an ion pair, eV: −14.40/(ε·r[Å]); 0 if not given."""
    return -COULOMB_EV_A / (eps * r_angstrom) if eps > 0 and r_angstrom > 0 else 0.0


def quench_dg(
    quencher_e_ox: float | None = None,
    quencher_e_red: float | None = None,
    e_star_ox: float | None = None,
    e_star_red: float | None = None,
    work: float = 0.0,
) -> dict[str, float | None]:
    """ΔG (eV) of photoinduced electron transfer (Rehm–Weller): reductive E_ox(Q) − E*red + w; oxidative E*ox − E_red(Q) + w."""
    return {
        "reductive": quencher_e_ox - e_star_red + work if quencher_e_ox is not None and e_star_red is not None else None,
        "oxidative": e_star_ox - quencher_e_red + work if quencher_e_red is not None and e_star_ox is not None else None,
    }


def _normalise(x: Sequence[float], y: Sequence[float]) -> list[tuple[float, float]]:
    pts = sorted((float(a), float(b)) for a, b in zip(x, y) if math.isfinite(a) and math.isfinite(b))
    if not pts:
        raise ValueError("Empty spectrum.")
    vis = [p for p in pts if p[0] > 300]
    use = vis if len(vis) > 5 else pts
    mx = max(p[1] for p in use)
    return [(a, b / mx) for a, b in pts]


def _interp(arr: list[tuple[float, float]], x: float) -> float:
    for i in range(1, len(arr)):
        if arr[i][0] >= x:
            x0, y0 = arr[i - 1]
            x1, y1 = arr[i]
            return y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)
    return float("nan")


def e00_from_spectra(abs_nm: Sequence[float], absorbance: Sequence[float], em_nm: Sequence[float], emission: Sequence[float]) -> tuple[float, float]:
    """(E0,0 in eV, λ in nm) where the normalised absorption and emission spectra cross between their maxima."""
    a, e = _normalise(abs_nm, absorbance), _normalise(em_nm, emission)
    abs_max = a[0]
    for p in a:
        if p[0] > 300 and p[1] >= 0.98:
            abs_max = p
    em_max = max(e, key=lambda p: p[1])
    if em_max[0] <= abs_max[0]:
        raise ValueError("The emission maximum must lie at a longer wavelength than the absorption maximum.")
    prev: float | None = None
    x = abs_max[0]
    while x <= em_max[0]:
        d = _interp(a, x) - _interp(e, x)
        if prev is not None and math.isfinite(d) and (d > 0) != (prev > 0):
            return HC_EV_NM / x, x
        prev = d
        x += 0.25
    raise ValueError("The normalised spectra do not cross between the two maxima.")


def photon_energy(nm: float) -> dict[str, float]:
    """Energy of a photon of wavelength ``nm``: eV, kcal/mol, kJ/mol, cm⁻¹."""
    ev = HC_EV_NM / nm
    return {"ev": ev, "kcal_mol": ev * KCAL_PER_EV, "kj_mol": ev * KJ_PER_EV, "cm-1": ev * CM1_PER_EV}


def photon_flux(power_mw: float, nm: float) -> float:
    """Photon flux (einstein s⁻¹) of a monochromatic source of ``power_mw`` mW at ``nm``."""
    return (power_mw / 1000) * (nm * 1e-9) / (H * C) / NA


def dg_from_de(delta_e_v: float, n_electrons: int = 1) -> dict[str, float]:
    """ΔG = −nFΔE: from a potential difference (V) to eV, kcal/mol and kJ/mol."""
    ev = -n_electrons * delta_e_v
    return {"ev": ev, "kcal_mol": ev * KCAL_PER_EV, "kj_mol": ev * KJ_PER_EV}


# ---------------- reaction library ----------------


def parse_reactions_js(text: str) -> list[Reaction]:
    """Reactions from the text of ``redox-reactions.js`` (``window.EntRedoxReactions = [...];``) or plain JSON."""
    m = re.search(r"=\s*(\[.*\])\s*;?\s*$", text, re.S)
    data = json.loads(m.group(1) if m else text)
    return [Reaction.from_dict(d) for d in data]


def load_reactions(path: str | Path | None = None, *, repo_root: str | Path | None = None) -> list[Reaction]:
    """The advisor's library: ``path`` (JS or JSON), else ``docs/assets/redox-reactions.js`` of the repository."""
    if path is None:
        from .config import find_repo_root

        root = Path(repo_root) if repo_root else find_repo_root()
        if root is None:
            raise FileNotFoundError("Reaction library not found: pass path=... (redox-reactions.js or a JSON copy) or run inside the repository.")
        path = root / "docs" / "assets" / "redox-reactions.js"
    return parse_reactions_js(Path(path).read_text(encoding="utf-8"))


# ---------------- reactivity advisor ----------------


@dataclass
class ReactionMatch:
    reaction: Reaction
    cycle: Cycle

    @property
    def verdict(self) -> str:
        return self.cycle.verdict

    def to_dict(self) -> dict[str, Any]:
        return {"reaction": self.reaction.id, "name": self.reaction.name, "doi": self.reaction.doi,
                "reported_quenching": self.reaction.reported_quenching, **self.cycle.to_dict()}


@dataclass
class SubstrateMatch:
    molecule: Any
    how: str
    dg: float  # eV

    @property
    def dg_kcal(self) -> float:
        return self.dg * KCAL_PER_EV

    def to_dict(self) -> dict[str, Any]:
        m = self.molecule
        return {"name": _name(m), "cas": _get(m, "cas"), "activated_group": _get(m, "activated_group"),
                "how": self.how, "dg_ev": round(self.dg, 3)}


@dataclass
class CatalystRank:
    photocatalyst: Any
    cycle: Cycle
    score: float
    overkill: bool  # photochemical step far more exergonic than needed
    warnings: list[str] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        return self.cycle.verdict

    def to_dict(self) -> dict[str, Any]:
        pc = self.photocatalyst
        return {"photocatalyst": _name(pc), "cas": _get(pc, "cas"), "e_star_ox": _get(pc, "e_star_ox"),
                "e_star_red": _get(pc, "e_star_red"), "score": round(self.score, 3), "overkill": self.overkill,
                "warnings": "; ".join(self.warnings), **self.cycle.to_dict()}


def reactions_for(pc: Any, reactions: Iterable[Reaction]) -> list[ReactionMatch]:
    """Reactions of the library that ``pc`` can drive, best verdict and largest driving force first."""
    out = [ReactionMatch(r, c) for r in reactions if (c := best_cycle(pc, r.donor, r.acceptor, r.reported_quenching, r.key))]
    out.sort(key=lambda m: (_RANK[m.cycle.verdict], m.cycle.score))
    return out


def substrates_in_reach(pc: Any, molecules: Iterable[Any], *, max_dg: float = BORDER) -> list[SubstrateMatch]:
    """Substrates ``pc`` can oxidise or reduce (photochemically or after quenching) with ΔG ≤ ``max_dg`` eV, most exergonic first."""
    eso, esr, e_ox, e_red = (_get(pc, k) for k in ("e_star_ox", "e_star_red", "e_ox", "e_red"))
    out: list[SubstrateMatch] = []
    for m in molecules:
        mo, mr = _get(m, "e_ox"), _get(m, "e_red")
        if mo is not None and esr is not None:
            out.append(SubstrateMatch(m, "PC* oxidises it", mo - esr))
        if mr is not None and eso is not None:
            out.append(SubstrateMatch(m, "PC* reduces it", eso - mr))
        if mr is not None and e_red is not None:
            out.append(SubstrateMatch(m, "PC•− reduces it (after reductive quenching)", e_red - mr))
        if mo is not None and e_ox is not None:
            out.append(SubstrateMatch(m, "PC•+ oxidises it (after oxidative quenching)", mo - e_ox))
    return sorted((x for x in out if x.dg <= max_dg), key=lambda x: x.dg)


def _partner_from(obj: Any, attr: str) -> Partner | None:
    """A Partner giving ``attr`` ("E_ox" | "E_red") from a Partner, a dict or a molecule (``e_ox``/``e_red``)."""
    if obj is None:
        return None
    if isinstance(obj, Partner):
        return obj if getattr(obj, attr) is not None else None
    v = _get(obj, attr)
    if v is None:
        v = _get(obj, attr.lower())
    if v is None:
        return None
    return Partner(_name(obj, "partner"), **{attr: v}, soft=bool(_get(obj, "soft")))


def rank_photocatalysts(
    catalysts: Iterable[Any],
    reaction: Reaction | None = None,
    *,
    substrate_e: float | None = None,
    direction: str = "ox",
    partner: Any = None,
    substrate_name: str = "substrate",
    avoid_overkill: bool = True,
    visible_only: bool = False,
) -> list[CatalystRank]:
    """Photocatalysts for a reaction of the library, or for a substrate to oxidise/reduce, best first.

    Without ``reaction``: the substrate has potential ``substrate_e`` (V vs SCE) and must be oxidised
    (``direction="ox"``, electron donor) or reduced (``"red"``, acceptor); ``partner`` (a molecule, a dict
    or a :class:`Partner`) closes the cycle. ``avoid_overkill`` penalises a photochemical step below
    −0.8 eV; ``visible_only`` drops catalysts absorbing only below 400 nm. Catalysts without the
    potentials needed for a verdict are left out.
    """
    if reaction is not None:
        D, A, reported, key = reaction.donor, reaction.acceptor, reaction.reported_quenching, reaction.key
    else:
        if substrate_e is None:
            raise ValueError("Give a reaction, or substrate_e with direction 'ox' or 'red'.")
        if direction not in ("ox", "red"):
            raise ValueError("direction must be 'ox' or 'red'")
        reported = None
        if direction == "ox":
            D, A, key = Partner(substrate_name, E_ox=substrate_e), _partner_from(partner, "E_red"), "donor"
        else:
            D, A, key = _partner_from(partner, "E_ox"), Partner(substrate_name, E_red=substrate_e), "acceptor"
    out: list[CatalystRank] = []
    for pc in catalysts:
        lmax, tau = _get(pc, "uv_lmax"), _get(pc, "tau_ns")
        if visible_only and lmax and lmax < 400:
            continue
        c = best_cycle(pc, D, A, reported, key)
        if c is None or c.verdict == "unknown":
            continue
        g0 = c.steps[0].g
        over = g0 is not None and g0 < OVERKILL
        score = c.score + ((OVERKILL - g0) * 0.5 if avoid_overkill and over else 0.0)  # type: ignore[operator]
        warn = []
        if lmax and lmax < 400:
            warn.append(f"absorbs at {lmax} nm (UV)")
        if tau is not None and tau < 5:
            warn.append(f"short-lived excited state (τ ≈ {tau} ns)")
        out.append(CatalystRank(pc, c, score, over, warn))
    out.sort(key=lambda x: (_RANK[x.cycle.verdict], not x.cycle.complete, x.score))
    return out
