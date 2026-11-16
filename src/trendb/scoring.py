"""1:1 Python port of docs/assets/score.js for normalisation, validation, and scoring."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import unquote

KCAL_PER_EV = 23.0605
KJ_PER_KCAL = 4.184
ET_MAX = 200

NUM_RE = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")
DOI_RE = re.compile(r'^10\.\d{4,9}/[^\s"<>]+$')
_DOI_EMBED_RE = re.compile(r'10\.\d{4,9}/[^\s?#"<>]+')
CAS_RE = re.compile(r"^(\d{2,7})-(\d{2})-(\d)$")
_DASHES_RE = re.compile(r"[\u2010-\u2015\u2212]")


def _str(v: Any, max_len: int = 500) -> str:
    return ("" if v is None else str(v)).strip()[:max_len]


def _js_round(x: float) -> int:
    """Replicate JavaScript Math.round() (half towards +infinity)."""
    return math.floor(x + 0.5)


def round1(x: float) -> float:
    return _js_round(x * 10.0) / 10.0


def round2(x: float) -> float:
    return _js_round(x * 100.0) / 100.0


def num(v: Any) -> float:
    """Strict number parser matching EntScore.num (accepts decimal comma)."""
    if isinstance(v, bool):
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else float("nan")
    t = ("" if v is None else str(v)).strip()
    if "," in t and "." not in t:
        t = t.replace(",", ".")
    if not NUM_RE.match(t):
        return float("nan")
    try:
        n = float(t)
    except ValueError:
        return float("nan")
    return n if math.isfinite(n) else float("nan")


def _pick(v: Any, allowed: tuple[str, ...], fallback: str) -> str:
    return v if v in allowed else fallback


def clean_doi(v: Any) -> str:
    """Reduce DOI URLs / prefixes / proxy links to the bare DOI string."""
    t = _str(v, 300)
    t = re.sub(r"^doi:\s*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"^https?://(dx\.)?doi\.org/", "", t, flags=re.IGNORECASE)
    if re.match(r"^(https?://|www\.)", t, flags=re.IGNORECASE):
        m = _DOI_EMBED_RE.search(t)
        if m:
            t = m.group(0)
            try:
                t = unquote(t)
            except Exception:
                pass
    t = re.sub(r"[.,;)\]]+$", "", t)
    return t[:200]


def is_doi(v: Any) -> bool:
    return bool(DOI_RE.match("" if v is None else str(v)))


def clean_cas(v: Any) -> str:
    t = re.sub(r"\s+", "", _str(v, 30))
    t = _DASHES_RE.sub("-", t)
    if re.match(r"^\d{5,10}$", t):
        t = f"{t[:-3]}-{t[-3:-1]}-{t[-1]}"
    return t


def cas_valid(v: Any) -> bool:
    m = CAS_RE.match("" if v is None else str(v))
    if not m:
        return False
    digits = list(reversed(m.group(1) + m.group(2)))
    total = sum((i + 1) * int(d) for i, d in enumerate(digits))
    return total % 10 == int(m.group(3))


def _parse_int_range(v: Any, min_val: int, max_val: int) -> tuple[int | None, bool]:
    if v is None or str(v).strip() == "":
        return None, False
    n = num(v)
    if math.isnan(n) or math.floor(n) != n or n < min_val or n > max_val:
        return None, True
    return int(n), False


def _parse_direct_exc(v: Any, src: Any = None, nm: Any = None) -> tuple[dict[str, int] | None, bool]:
    has_pair = (src is not None and str(src).strip() != "") or (nm is not None and str(nm).strip() != "")
    if v is None and has_pair:
        val, bad = _parse_int_range(nm, 100, 1500)
        if bad or val is None:
            return None, True
        key = _str(src, 40) or "irradiation"
        return {key: val}, False
    if v is None or v == "":
        return None, False
    obj: Any = None
    if isinstance(v, dict):
        obj = v
    else:
        import json

        s = str(v).strip()
        if not s:
            return None, False
        if s.startswith("{"):
            try:
                obj = json.loads(s)
            except Exception:
                return None, True
        else:
            obj = {}
            for part in re.split(r"[;,]+", s):
                t = part.strip()
                if not t:
                    continue
                m1 = re.match(r"^([^:]+?)\s*:\s*(\d{3,4})\s*(?:nm)?$", t, re.IGNORECASE)
                m2 = re.match(r"^(\d{3,4})\s*nm\s*(.*)$", t, re.IGNORECASE)
                if m1:
                    obj[_str(m1.group(1), 40) or "irradiation"] = int(m1.group(2))
                elif m2:
                    obj[_str(m2.group(2), 40) or "irradiation"] = int(m2.group(1))
                else:
                    return None, True
            if not obj:
                return None, True
    if not isinstance(obj, dict):
        return None, True
    if not obj:
        return None, False
    clean: dict[str, int] = {}
    for k, val in obj.items():
        key = _str(k, 40)
        parsed, bad = _parse_int_range(val, 100, 1500)
        if not key or bad or parsed is None:
            return None, True
        clean[key] = parsed
    return clean, False


def normalize(p: dict[str, Any] | None) -> dict[str, Any]:
    """Normalise raw entry payload matching EntScore.normalize."""
    p = p or {}
    unit = _pick(p.get("unit"), ("kcal", "kj", "ev"), "kcal")
    k = 1.0 / KJ_PER_KCAL if unit == "kj" else KCAL_PER_EV if unit == "ev" else 1.0
    et = num(p.get("et"))
    unc = num(p.get("unc"))
    doi = clean_doi(p.get("doi"))

    lmax_in = p.get("uv_lmax")
    cond_in = p.get("uv_cond")
    if lmax_in is None and cond_in is None and p.get("uv"):
        um = re.search(r"(\d{3,4})\s*nm", str(p["uv"]), re.IGNORECASE)
        if um:
            lmax_in = um.group(1)
        cond_in = re.sub(r"^\s*(?:λmax\s*)?\d{3,4}\s*nm\s*", "", str(p["uv"]), flags=re.IGNORECASE).strip()

    uv_lmax, uv_lmax_bad = _parse_int_range(lmax_in, 100, 1500)
    uv_eps, uv_eps_bad = _parse_int_range(p.get("uv_eps"), 0, 100_000_000)
    direct_in = p["direct_exc"] if p.get("direct_exc") is not None else p.get("direct")
    direct_exc, direct_bad = _parse_direct_exc(direct_in, p.get("direct_src"), p.get("direct_nm"))

    return {
        "name": _str(p.get("name"), 200),
        "commercial_name": _str(p.get("commercial_name"), 200),
        "cas": clean_cas(p.get("cas")),
        "cls": _str(p.get("cls"), 80),
        "smiles": _str(p.get("smiles"), 400),
        "role": _pick(p.get("role"), ("acceptor", "donor", "both"), "acceptor"),
        "et": et,
        "unit": unit,
        "unc": unc,
        "kcal": float("nan") if math.isnan(et) else et * k,
        "uncKcal": float("nan") if math.isnan(unc) else abs(unc) * k,
        "origin": "calc" if p.get("origin") == "calc" else "exp",
        "kind": _str(p.get("kind"), 80),
        "tech": _str(p.get("tech"), 80),
        "solvent": _str(p.get("solvent"), 120),
        "temp": _str(p.get("temp"), 60),
        "func": _str(p.get("func"), 120),
        "basis": _str(p.get("basis"), 120),
        "solv": _str(p.get("solv"), 120),
        "cite": _str(p.get("cite"), 400),
        "doi": doi,
        "loc": _str(p.get("loc"), 200),
        "quote": _str(p.get("quote"), 300),
        "uv_lmax": uv_lmax,
        "uv_lmax_bad": uv_lmax_bad,
        "uv_eps": uv_eps,
        "uv_eps_bad": uv_eps_bad,
        "uv_cond": _str(cond_in, 120),
        "direct_exc": direct_exc,
        "direct_bad": direct_bad,
        "by": _str(p.get("by"), 120),
        "usedoi": clean_doi(p.get("usedoi")),
        "usenote": _str(p.get("usenote"), 300),
    }


def grade_of(n: int) -> dict[str, str]:
    if n >= 80:
        return {"label": "Good", "cls": "exp"}
    if n >= 50:
        return {"label": "Fair", "cls": "warn"}
    return {"label": "Poor", "cls": "bad"}


def score_entry(f: dict[str, Any], ctx: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compute quality score (0..100) and breakdown items matching EntScore.scoreEntry."""
    ctx = ctx or {}
    items: list[dict[str, Any]] = []

    def add(label: str, got: int, max_pts: int, note: str = "") -> None:
        items.append({"label": label, "got": got, "max": max_pts, "note": note or ""})

    structure_ok = ctx.get("structureOk")
    if structure_ok is None:
        add("Structure parses", 0, 15, "Not checked: the structure library was unavailable")
    else:
        add(
            "Structure parses",
            15 if structure_ok else 0,
            15,
            "" if structure_ok else ("The SMILES could not be read" if f.get("smiles") else "No structure given"),
        )

    add("IUPAC name given", 3 if f.get("name") else 0, 3)

    kcal = f.get("kcal", float("nan"))
    ok_et = not math.isnan(kcal) and 20 <= kcal <= 120
    add(
        "E_T in a plausible range",
        12 if ok_et else 0,
        12,
        "No value given" if math.isnan(kcal) else ("" if ok_et else "Outside 20–120 kcal/mol: check the unit"),
    )

    kind = f.get("kind") or ""
    stated = bool(kind and kind != "Other or not stated")
    computed_kind = bool(re.match(r"^Computed", kind))
    if stated and f.get("origin") != "calc" and computed_kind:
        add("Value type stated", 5, 8, "A computed value type on a measured value")
    else:
        add("Value type stated", 8 if stated else 0, 8)

    if f.get("origin") == "calc":
        add("Method or functional", 8 if f.get("func") else 0, 8)
        add("Basis set", 7 if f.get("basis") else 0, 7)
        add("Solvent model", 5 if f.get("solv") else 0, 5)
        add(
            "Value type matches a computation",
            3 if computed_kind else 0,
            3,
            "" if computed_kind else "Choose adiabatic or vertical",
        )
    else:
        add("Technique", 10 if f.get("tech") else 0, 10)
        add("Solvent or matrix", 5 if f.get("solvent") else 0, 5)
        add("Temperature", 5 if f.get("temp") else 0, 5)
        unc = f.get("unc", float("nan"))
        add("Uncertainty given", 3 if not math.isnan(unc) else 0, 3)

    doi = f.get("doi") or ""
    doi_ok = is_doi(doi)
    add("DOI well formed", 6 if doi_ok else 0, 6, "This does not look like a DOI" if (doi and not doi_ok) else "")
    doi_resolves = ctx.get("doiResolves")
    if not doi_ok:
        add("DOI resolves", 0, 6, "" if doi else "No DOI given")
    elif doi_resolves is None:
        add("DOI resolves", 0, 6, "Checked when the entry is submitted")
    else:
        add("DOI resolves", 6 if doi_resolves else 0, 6, "" if doi_resolves else "doi.org does not know this DOI")

    add("Citation", 5 if f.get("cite") else 0, 5)
    add("Location in the paper", 6 if f.get("loc") else 0, 6)

    quote = f.get("quote") or ""
    words = len(re.split(r"\s+", quote)) if quote else 0
    add(
        "Verbatim line",
        4 if (0 < words <= 25) else 0,
        4,
        "Keep it to one short line (25 words or fewer)" if words > 25 else "",
    )

    cons = 0
    note = "No structure to compare"
    same = ctx.get("same")
    if same is not None and not math.isnan(kcal):
        dup = None
        best = float("inf")
        mine = round1(kcal)
        origin = f.get("origin") or "exp"
        peers = [d for d in same if not d.get("origin") or d.get("origin") == origin]
        for d in peers:
            d_et = float(d["et_kcal"])
            diff = abs(d_et - kcal)
            if diff < best:
                best = diff
            if doi and str(d.get("doi") or "").lower() == doi.lower() and abs(round1(d_et) - mine) < 0.05:
                dup = d
        if dup is not None:
            cons = 0
            note = f"Looks like a duplicate of “{dup.get('name', '')}” (same structure, DOI and value)"
        elif not peers:
            cons = 8
            if same:
                kind_lbl = "computed" if origin == "calc" else "measured"
                note = f"No existing {kind_lbl} value for this structure"
            else:
                note = "No existing entry for this structure"
        else:
            cons = 8 if best <= 5 else (5 if best <= 10 else 2)
            note = (
                "Within 5 kcal/mol of an existing entry for this structure"
                if best <= 5
                else f"Differs by {best:.1f} kcal/mol from the closest existing entry. This can be right if the value type differs"
            )
    add("Consistency with the database", cons, 8, note)

    add(
        "UV-vis or excitation data",
        4 if (f.get("uv_lmax") is not None or f.get("uv_cond") or f.get("direct_exc")) else 0,
        4,
    )

    total = sum(i["got"] for i in items)
    return {"total": total, "grade": grade_of(total)["label"], "items": items}


def required_error(f: dict[str, Any], ctx: dict[str, Any] | None = None) -> str | None:
    """Validate minimum requirements matching EntScore.requiredError."""
    ctx = ctx or {}
    if not f.get("smiles"):
        return "Add the structure as a SMILES or draw it."
    if ctx.get("structureOk") is False:
        return "The SMILES could not be read. Fix it or redraw the structure."
    if not f.get("name"):
        return "Enter the IUPAC name."
    kcal = f.get("kcal", float("nan"))
    if math.isnan(kcal):
        return "Enter the triplet energy value."
    if not (0 < kcal <= ET_MAX):
        return f"The triplet energy must be above 0 and at most {ET_MAX} kcal/mol. Check the value and the unit."
    if not f.get("cite") and not f.get("doi"):
        return "Add a citation or a DOI so the value can be traced."
    if f.get("doi") and not is_doi(f["doi"]):
        return "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link."
    if f.get("cas") and not cas_valid(f["cas"]):
        return "The CAS number is not valid: check the digits and the format (for example 100-42-5)."
    if f.get("uv_lmax_bad"):
        return "UV-vis λmax must be an integer between 100 and 1500 nm."
    if f.get("uv_eps_bad"):
        return "UV-vis ε must be a non-negative integer."
    if f.get("direct_bad"):
        return "Direct excitation must be a wavelength (100–1500 nm) or a {source: nm} map."
    if f.get("usedoi") and not is_doi(f["usedoi"]):
        return "The DOI of the paper where the molecule was used does not look like a DOI."
    if f.get("usenote") and not f.get("usedoi"):
        return "Add the DOI of the paper the description refers to."
    return None


# ================= redox potentials (table redox_entries) =================
# 1:1 port of EntScore.redox in docs/assets/score.js.

E_MAX = 5.0  # V; anything beyond is a typing or unit error, never stored
E_PLAUSIBLE = 3.5  # V vs SCE
REDOX_STATES = ("S0", "S1", "T1")
REDOX_KINDS = ("red", "ox")
EXCITED_FROM = ("direct", "estimated")
REDOX_CATEGORIES = ("photocatalyst", "substrate")
_NAN = float("nan")

# Reference electrodes and their offset to SCE (V): E(vs SCE) = E(vs ref) + off.
# RedoxDB's table (alebusso12, used with permission), after Pavlishchuk & Addison 2000 and
# Connelly & Geiger 1996. None = depends on the solvent (Fc+/Fc), NaN = cannot be converted.
REF_TABLE: tuple[dict[str, Any], ...] = (
    {"id": "SCE", "off": 0.0},
    {"id": "SHE", "off": -0.241},
    {"id": "NHE", "off": -0.241},
    {"id": "Fc+/Fc", "off": None},
    {"id": "Me10Fc+/Me10Fc", "off": -0.13, "note": "in MeCN"},
    {"id": "Ag/AgCl (sat. KCl)", "off": -0.045},
    {"id": "Ag/AgCl (3 M KCl)", "off": -0.032},
    {"id": "Ag/AgCl (1 M KCl)", "off": 0.0},
    {"id": "Ag/AgCl (3.5 M NaCl)", "off": -0.03, "note": "convention of Roth, Romero, Nicewicz 2016"},
    {"id": "Ag/AgCl", "off": -0.045, "note": "filling not stated: saturated KCl assumed"},
    {"id": "Ag/Ag+ (0.01 M AgNO3, MeCN)", "off": 0.298},
    {"id": "Ag/Ag+ (0.1 M AgNO3, MeCN)", "off": 0.36},
    {"id": "Ag/Ag+", "off": _NAN, "note": "depends on the Ag+ concentration: not converted"},
    {"id": "other", "off": _NAN},
)
REDOX_REFS = tuple(r["id"] for r in REF_TABLE)
_FC_VS_SCE: tuple[tuple[re.Pattern[str], float], ...] = (
    (re.compile(r"\b(mecn|acetonitrile|ch3cn|acn)\b", re.IGNORECASE), 0.38),
    (re.compile(r"\b(dmf|dimethylformamide)\b", re.IGNORECASE), 0.45),
    (re.compile(r"\b(ch2cl2|dcm|dichloromethane|methylene chloride)\b", re.IGNORECASE), 0.46),
    (re.compile(r"\b(thf|tetrahydrofuran)\b", re.IGNORECASE), 0.56),
    (re.compile(r"\b(dmso|dimethyl sulfoxide|dimethylsulfoxide)\b", re.IGNORECASE), 0.43),
)


def round3(x: float) -> float:
    return _js_round(x * 1000.0) / 1000.0


def _js_num_str(x: float) -> str:
    """String(x) as JavaScript prints a number (2.0 -> "2", -0.89 -> "-0.89")."""
    if math.isfinite(x) and x == math.floor(x) and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def _ref_key(s: Any) -> str:
    return re.sub(r"[\s(),]", "", ("" if s is None else str(s)).lower())


_REF_BY_KEY = {_ref_key(r["id"]): r["id"] for r in REF_TABLE}


def clean_ref(v: Any) -> str:
    """Reference electrode as typed or extracted -> one of REDOX_REFS ("" when nothing was given)."""
    t = re.sub(r"^vs\.?\s*", "", _str(v, 60), flags=re.IGNORECASE)
    if not t:
        return ""
    low = _ref_key(t)
    if low in _REF_BY_KEY:
        return _REF_BY_KEY[low]
    if re.match(r"^(me10fc|decamethylferrocen|dmfc)", low):
        return "Me10Fc+/Me10Fc"
    if re.match(r"^(fc\+?/fc\+?|ferrocenium/ferrocene|ferrocene|fc)$", low):
        return "Fc+/Fc"
    if low.startswith("ag/agcl"):
        if "nacl" in low:
            return "Ag/AgCl (3.5 M NaCl)" if "3.5m" in low else "Ag/AgCl"
        if "sat" in low:
            return "Ag/AgCl (sat. KCl)"
        if re.search(r"(^|[^.\d])3(\.0)?m", low):
            return "Ag/AgCl (3 M KCl)"
        if re.search(r"(^|[^.\d])1(\.0)?m", low):
            return "Ag/AgCl (1 M KCl)"
        return "Ag/AgCl"
    if re.match(r"^(ag/ag\+|ag\+/ag)", low):
        if "0.01m" in low:
            return "Ag/Ag+ (0.01 M AgNO3, MeCN)"
        if "0.1m" in low:
            return "Ag/Ag+ (0.1 M AgNO3, MeCN)"
        return "Ag/Ag+"
    return "other"


def ref_info(ref: str) -> dict[str, Any] | None:
    return next((r for r in REF_TABLE if r["id"] == ref), None)


def fc_offset(solvent: Any) -> float:
    s = "" if solvent is None else str(solvent)
    hits = [off for rx, off in _FC_VS_SCE if rx.search(s)]
    return hits[0] if len(hits) == 1 else _NAN


def ref_offset(ref: str, solvent: Any = None) -> float:
    """Offset of ref against SCE (V), or NaN when it cannot be converted."""
    r = ref_info(ref)
    if r is None:
        return _NAN
    return fc_offset(solvent) if r["off"] is None else float(r["off"])


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def to_sce(v: float, ref: str, solvent: Any = None) -> float:
    """Potential (V) against ref -> V against SCE, or NaN when it cannot be converted."""
    off = ref_offset(ref, solvent)
    return _NAN if not _finite(v) or math.isnan(off) else round3(v + off)


def from_sce(v: float, ref: str, solvent: Any = None) -> float:
    """Potential (V) against SCE -> V against ref, or NaN when it cannot be converted."""
    off = ref_offset(ref, solvent)
    return _NAN if not _finite(v) or math.isnan(off) else round3(v - off)


def normalize_redox(p: dict[str, Any] | None) -> dict[str, Any]:
    """Normalise a redox payload matching EntScore.redox.normalize."""
    p = p or {}
    unit = _pick(p.get("unit"), ("v", "mv"), "v")
    k = 0.001 if unit == "mv" else 1.0
    e = num(p.get("e"))
    unc = num(p.get("unc"))
    state = _pick(p.get("state"), REDOX_STATES, "S0")
    excited = state != "S0"
    origin = "calc" if p.get("origin") == "calc" else "exp"
    uv_lmax, uv_lmax_bad = _parse_int_range(p.get("uv_lmax"), 100, 1500)
    tau = num(p.get("tau_ns"))
    f: dict[str, Any] = {
        "property": "redox",
        "name": _str(p.get("name"), 200),
        "commercial_name": _str(p.get("commercial_name"), 200),
        "cas": clean_cas(p.get("cas")),
        "cls": _str(p.get("cls"), 80),
        "smiles": _str(p.get("smiles"), 400),
        "kind": _pick(p.get("kind"), REDOX_KINDS, "red"),
        "state": state,
        "couple": _str(p.get("couple"), 40),
        "excited_from": _pick(p.get("excited_from"), EXCITED_FROM, "") if excited else "",
        "e00": num(p.get("e00")) if excited else _NAN,
        "e00_note": _str(p.get("e00_note"), 200) if excited else "",
        "e": e,
        "unit": unit,
        "unc": unc,
        "v": _NAN if math.isnan(e) else e * k,
        "uncV": _NAN if math.isnan(unc) else abs(unc) * k,
        "ref": clean_ref(p.get("ref")),
        "origin": origin,
        "e_type": _str(p.get("e_type"), 80),
        "tech": _str(p.get("tech"), 80),
        "solvent": _str(p.get("solvent"), 120),
        "electrolyte": _str(p.get("electrolyte"), 120),
        "temp": _str(p.get("temp"), 60),
        "func": _str(p.get("func"), 120),
        "basis": _str(p.get("basis"), 120),
        "solv": _str(p.get("solv"), 120),
        "cite": _str(p.get("cite"), 400),
        "doi": clean_doi(p.get("doi")),
        "loc": _str(p.get("loc"), 200),
        "quote": _str(p.get("quote"), 300),
        "by": _str(p.get("by"), 120),
        "category": _pick(p.get("category"), REDOX_CATEGORIES, ""),
        "activated_group": _str(p.get("activated_group"), 80),
        "uv_lmax": uv_lmax,
        "uv_lmax_bad": uv_lmax_bad,
        "tau_ns": tau,
        "tau_bad": not math.isnan(tau) and not tau >= 0,
    }
    f["sce"] = to_sce(f["v"], f["ref"], f["solv"] if origin == "calc" else f["solvent"])
    return f


def score_redox(f: dict[str, Any], ctx: dict[str, Any] | None = None) -> dict[str, Any]:
    """Quality score (0..100) of a redox entry matching EntScore.redox.scoreEntry."""
    ctx = ctx or {}
    items: list[dict[str, Any]] = []

    def add(label: str, got: int, max_pts: int, note: str = "") -> None:
        items.append({"label": label, "got": got, "max": max_pts, "note": note or ""})

    structure_ok = ctx.get("structureOk")
    if structure_ok is None:
        add("Structure parses", 0, 15, "Not checked: the structure library was unavailable")
    else:
        add(
            "Structure parses",
            15 if structure_ok else 0,
            15,
            "" if structure_ok else ("The SMILES could not be read" if f.get("smiles") else "No structure given"),
        )

    add("IUPAC name given", 3 if f.get("name") else 0, 3)

    v, sce = f.get("v", _NAN), f.get("sce", _NAN)
    probe = v if math.isnan(sce) else sce
    ok_e = not math.isnan(probe) and abs(probe) <= E_PLAUSIBLE
    add(
        "Potential in a plausible range",
        8 if ok_e else 0,
        8,
        "No value given" if math.isnan(v) else ("" if ok_e else f"Beyond ±{_js_num_str(E_PLAUSIBLE)} V: check the unit and the sign"),
    )

    ref = f.get("ref") or ""
    add(
        "Reference electrode stated",
        7 if (ref and ref != "other") else 0,
        7,
        "An unlisted reference cannot be compared with other values" if ref == "other" else "",
    )
    if not math.isnan(sce):
        sce_note = "Filling not stated: saturated KCl assumed" if ref == "Ag/AgCl" else ""
    elif ref == "Fc+/Fc":
        sce_note = "Give the solvent so Fc+/Fc can be converted"
    elif ref == "Ag/Ag+":
        sce_note = "Give the Ag+ concentration so Ag/Ag+ can be converted"
    else:
        sce_note = ""
    add("Converts to SCE", 0 if math.isnan(sce) else 4, 4, sce_note)

    e_type = f.get("e_type") or ""
    stated = bool(e_type and e_type != "Other or not stated")
    computed_kind = bool(re.match(r"^Computed", e_type))
    if stated and f.get("origin") != "calc" and computed_kind:
        add("Value type stated", 3, 5, "A computed value type on a measured value")
    else:
        add("Value type stated", 5 if stated else 0, 5)

    if f.get("state") == "S0":
        couple = f.get("couple")
        add("Redox couple or E* derivation", 4 if couple else 0, 4, "" if couple else "Give the couple, e.g. M/M•−")
    else:
        ef = f.get("excited_from")
        derived = ef == "direct" or (ef == "estimated" and not math.isnan(f.get("e00", _NAN)))
        add(
            "Redox couple or E* derivation",
            4 if derived else 0,
            4,
            "" if derived else ("Give the E0,0 used for the estimate" if ef == "estimated" else "Say whether E* was measured or estimated from E0,0"),
        )

    if f.get("origin") == "calc":
        add("Method or functional", 7 if f.get("func") else 0, 7)
        add("Basis set", 6 if f.get("basis") else 0, 6)
        add("Solvent model", 5 if f.get("solv") else 0, 5)
        add("Value type matches a computation", 2 if computed_kind else 0, 2, "" if computed_kind else "Choose adiabatic or vertical")
    else:
        add("Technique", 8 if f.get("tech") else 0, 8)
        add("Solvent", 5 if f.get("solvent") else 0, 5)
        add("Supporting electrolyte", 4 if f.get("electrolyte") else 0, 4)
        add("Uncertainty or temperature", 3 if (not math.isnan(f.get("unc", _NAN)) or f.get("temp")) else 0, 3)

    doi = f.get("doi") or ""
    doi_ok = is_doi(doi)
    add("DOI well formed", 6 if doi_ok else 0, 6, "This does not look like a DOI" if (doi and not doi_ok) else "")
    doi_resolves = ctx.get("doiResolves")
    if not doi_ok:
        add("DOI resolves", 0, 6, "" if doi else "No DOI given")
    elif doi_resolves is None:
        add("DOI resolves", 0, 6, "Checked when the entry is submitted")
    else:
        add("DOI resolves", 6 if doi_resolves else 0, 6, "" if doi_resolves else "doi.org does not know this DOI")

    add("Citation", 4 if f.get("cite") else 0, 4)
    add("Location in the paper", 6 if f.get("loc") else 0, 6)
    quote = f.get("quote") or ""
    words = len(re.split(r"\s+", quote)) if quote else 0
    add("Verbatim line", 4 if (0 < words <= 25) else 0, 4, "Keep it to one short line (25 words or fewer)" if words > 25 else "")

    cons, note = 0, "No structure to compare"
    same = ctx.get("same")
    if same is not None and not math.isnan(v):
        peers = [
            d
            for d in same
            if (not d.get("origin") or d.get("origin") == f.get("origin"))
            and (d.get("kind") or "red") == f.get("kind")
            and (d.get("state") or "S0") == f.get("state")
        ]
        comparable = [d for d in peers if d.get("e_sce") is not None and not math.isnan(num(d["e_sce"]))]
        if not peers:
            cons = 8
            note = "No existing value of this kind for this structure" if same else "No existing entry for this structure"
        elif math.isnan(sce) or not comparable:
            cons, note = 4, "Cannot compare: no value against SCE"
        else:
            dup = None
            best = float("inf")
            mine = round3(sce)
            for d in comparable:
                d_sce = float(d["e_sce"])
                diff = abs(d_sce - sce)
                if diff < best:
                    best = diff
                if doi and str(d.get("doi") or "").lower() == doi.lower() and abs(round3(d_sce) - mine) < 0.0005:
                    dup = d
            if dup is not None:
                cons = 0
                note = f"Looks like a duplicate of “{dup.get('name', '')}” (same structure, DOI and value)"
            else:
                cons = 8 if best <= 0.1 else (5 if best <= 0.2 else 2)
                note = (
                    "Within 0.1 V of an existing entry for this structure"
                    if best <= 0.1
                    else f"Differs by {best:.2f} V from the closest existing entry. This can be right if the conditions differ"
                )
    add("Consistency with the database", cons, 8, note)

    total = sum(i["got"] for i in items)
    return {"total": total, "grade": grade_of(total)["label"], "items": items}


def required_redox_error(f: dict[str, Any], ctx: dict[str, Any] | None = None) -> str | None:
    """Minimum a redox entry needs, matching EntScore.redox.requiredError."""
    ctx = ctx or {}
    if not f.get("smiles"):
        return "Add the structure as a SMILES or draw it."
    if ctx.get("structureOk") is False:
        return "The SMILES could not be read. Fix it or redraw the structure."
    if not f.get("name"):
        return "Enter the IUPAC name."
    v = f.get("v", _NAN)
    if math.isnan(v):
        return "Enter the potential."
    if not abs(v) <= E_MAX:
        return f"The potential must be between −{_js_num_str(E_MAX)} and +{_js_num_str(E_MAX)} V. Check the value and the unit."
    if not f.get("ref"):
        return "Choose the reference electrode the potential was reported against."
    unc_v = f.get("uncV", _NAN)
    if not math.isnan(unc_v) and unc_v > 1:
        return "The uncertainty must be at most 1 V."
    e00 = f.get("e00", _NAN)
    if not math.isnan(e00) and not (0 < e00 <= 6):
        return "E00 must be above 0 and at most 6 eV."
    if not f.get("cite") and not f.get("doi"):
        return "Add a citation or a DOI so the value can be traced."
    if f.get("doi") and not is_doi(f["doi"]):
        return "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link."
    if f.get("cas") and not cas_valid(f["cas"]):
        return "The CAS number is not valid: check the digits and the format (for example 100-42-5)."
    if f.get("uv_lmax_bad"):
        return "UV-vis λmax must be an integer between 100 and 1500 nm."
    if f.get("tau_bad"):
        return "The excited-state lifetime must be a positive number of nanoseconds."
    return None


def to_redox_doc(f: dict[str, Any], sc: dict[str, Any]) -> dict[str, Any]:
    """Normalised redox fields + score -> redox_entries row, matching EntScore.redox.toDoc."""
    calc = f.get("origin") == "calc"
    unc = f.get("unc", _NAN)
    doc: dict[str, Any] = {
        "name": f.get("name") or "(unnamed)",
        "smiles": f.get("smiles"),
        "kind": f.get("kind"),
        "state": f.get("state"),
        "origin": f.get("origin"),
        "e_v": round3(f["v"]),
        "e_ref": f.get("ref"),
        "e_reported": _js_num_str(f["e"])
        + ("" if math.isnan(unc) else " ± " + _js_num_str(unc))
        + (" mV" if f.get("unit") == "mv" else " V")
        + " vs "
        + str(f.get("ref")),
        "e_type": f.get("e_type") or "Not stated",
        "method": ", ".join(x for x in ("Computation", f.get("func"), f.get("basis")) if x)
        if calc
        else (f.get("tech") or "Not stated"),
        "conditions": f.get("solv") if calc else ", ".join(x for x in (f.get("solvent"), f.get("electrolyte"), f.get("temp")) if x),
        "source_kind": "form",
        "score": sc["total"],
        "score_items": sc["items"],
    }
    if not math.isnan(f.get("sce", _NAN)):
        doc["e_sce"] = f["sce"]
    if not math.isnan(f.get("uncV", _NAN)):
        doc["e_unc"] = round3(f["uncV"])
    if f.get("state") != "S0":
        if f.get("excited_from"):
            doc["excited_from"] = f["excited_from"]
        if not math.isnan(f.get("e00", _NAN)):
            doc["e00_ev"] = round3(f["e00"])
    if f.get("uv_lmax") is not None:
        doc["uv_lmax"] = f["uv_lmax"]
    if not math.isnan(f.get("tau_ns", _NAN)):
        doc["tau_ns"] = f["tau_ns"]
    for key, val in (
        ("commercial_name", f.get("commercial_name")),
        ("cas", f.get("cas")),
        ("cls", f.get("cls")),
        ("couple", f.get("couple")),
        ("e00_note", f.get("e00_note")),
        ("solvent", "" if calc else f.get("solvent")),
        ("electrolyte", "" if calc else f.get("electrolyte")),
        ("category", f.get("category")),
        ("activated_group", f.get("activated_group")),
        ("citation", f.get("cite")),
        ("doi", f.get("doi")),
        ("location", f.get("loc")),
        ("quote", f.get("quote")),
        ("submitted_by", f.get("by")),
    ):
        if val:
            doc[key] = val
    return doc
