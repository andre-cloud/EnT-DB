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
