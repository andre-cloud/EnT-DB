"""Normalisers and length/conciseness checks for TrEnDB metadata fields."""

from __future__ import annotations

import re
from typing import Any

# Compact target lengths for structured card fields (keeps cards scannable, avoids prose "papiri")
FIELD_SOFT_LIMITS: dict[str, int] = {
    "uv_cond": 65,
    "et_type": 55,
    "method": 65,
    "conditions": 50,
}

_PROSE_PREFIX_RE = re.compile(
    r"^(?:the\s+paper\s+(?:excites|irradiates|uses|states|reports)|absorption\s+maximum|"
    r"longest-wavelength\s+absorption\s+maximum|lowest-energy\s+absorption\s+maximum)",
    re.IGNORECASE,
)


def parse_uv_fields(val: str | None) -> tuple[int | None, int | None, str | None]:
    """Parse free-text UV-vis string into structured (uv_lmax, uv_eps, uv_cond)."""
    cleaned = clean_uv(val)
    if not cleaned:
        return None, None, None

    # Special multi-band log-epsilon format: "λmax 260 (log ε 4.74), 310 (4.53), 380 nm (3.79) (MeCN)"
    m_log = re.match(
        r"^λmax\s+260\s*\(log\s*ε\s*([\d.]+)\),\s*310\s*\(([\d.]+)\),\s*(\d{3,4})\s*nm\s*\(([\d.]+)\)\s*\(([^()]+)\)$",
        cleaned,
        re.IGNORECASE,
    )
    if m_log:
        eps_val = round(10 ** float(m_log.group(4)))
        cond = f"{m_log.group(5).strip()} (also 260 nm log ε {m_log.group(1)}, 310 nm {m_log.group(2)})"
        return int(m_log.group(3)), eps_val, cond[:120]

    lmax: int | None = None
    eps: int | None = None
    extra_notes: list[str] = []

    # Trailing parenthetical conditions e.g. "(THF, 10⁻⁴ M)" or "(MeCN)"
    cond_base: str | None = None
    work = cleaned
    m_cond = re.search(r"\(([^()]+)\)\s*$", work)
    if m_cond and not re.match(r"^ε\b", m_cond.group(1).strip(), re.IGNORECASE):
        cond_base = m_cond.group(1).strip()
        work = work[: m_cond.start()].strip()

    # Main λmax
    m_lmax = re.search(r"λmax\s*(?:at|=|:)?\s*(\d{3,4})\s*nm|\b(\d{3,4})\s*nm\b", work, re.IGNORECASE)
    if m_lmax:
        lmax = int(m_lmax.group(1) or m_lmax.group(2))

    # Primary ε at λmax e.g. "(ε 20,000 M⁻¹ cm⁻¹)"
    m_main_eps = re.search(r"\(ε\s*=?\s*([0-9][0-9,]*)", work)
    if m_main_eps:
        eps = int(m_main_eps.group(1).replace(",", ""))

    # Secondary or sole ε at specific wavelength e.g. "ε(427) 61 M⁻¹ cm⁻¹"
    m_at_eps = re.search(r"ε\((\d{3,4})\)\s*([0-9][0-9,]*)\s*(M⁻¹\s*cm⁻¹)?", work)
    if m_at_eps:
        wl_at = int(m_at_eps.group(1))
        val_at = int(m_at_eps.group(2).replace(",", ""))
        if eps is None:
            eps = val_at
            if wl_at != lmax:
                extra_notes.append(f"ε at {wl_at} nm")
        else:
            extra_notes.append(f"ε({wl_at} nm) {val_at} M⁻¹ cm⁻¹")
    elif eps is None:
        m_plain_eps = re.search(r"\bε\s*=?\s*([0-9][0-9,]*)", work)
        if m_plain_eps:
            eps = int(m_plain_eps.group(1).replace(",", ""))

    if cond_base and extra_notes:
        uv_cond = f"{cond_base}; {'; '.join(extra_notes)}"
    elif cond_base:
        uv_cond = cond_base
    elif extra_notes:
        uv_cond = "; ".join(extra_notes)
    else:
        uv_cond = None
    return lmax, eps, (uv_cond[:120] if uv_cond else None)


def parse_direct_exc(val: Any) -> dict[str, int] | None:
    """Parse direct excitation into a compact {source: nm_int} map."""
    if val is None or val == "":
        return None
    if isinstance(val, dict):
        out: dict[str, int] = {}
        for k, v in val.items():
            key = str(k).strip()[:40] or "irradiation"
            try:
                nm = int(v)
            except (TypeError, ValueError):
                continue
            if 100 <= nm <= 1500:
                out[key] = nm
        return out or None

    cleaned = clean_direct_exc(str(val))
    if not cleaned:
        return None
    if cleaned.startswith("{"):
        import json

        try:
            return parse_direct_exc(json.loads(cleaned))
        except Exception:
            return None

    out = {}
    for part in re.split(r"[;,]+", cleaned):
        t = part.strip()
        if not t:
            continue
        m1 = re.match(r"^([^:]+?)\s*:\s*(\d{3,4})\s*(?:nm)?$", t, re.IGNORECASE)
        m2 = re.match(r"^(\d{3,4})\s*nm\s*(.*)$", t, re.IGNORECASE)
        m3 = re.match(r"^(.*?)\s+(\d{3,4})\s*nm$", t, re.IGNORECASE)
        if m1:
            nm = int(m1.group(2))
            if 100 <= nm <= 1500:
                out[m1.group(1).strip()[:40] or "irradiation"] = nm
        elif m2:
            nm = int(m2.group(1))
            src = m2.group(2).strip()[:40] or "irradiation"
            if 100 <= nm <= 1500:
                out[src] = nm
        elif m3:
            nm = int(m3.group(2))
            src = m3.group(1).strip()[:40] or "irradiation"
            if 100 <= nm <= 1500:
                out[src] = nm
    return out or None


def clean_uv(val: str | None) -> str | None:
    """Normalise UV-vis string into concise 'λmax ... nm (...)' notation."""
    if not val:
        return None
    s = re.sub(r"\s+", " ", val.strip())
    s = re.sub(
        r"^(?:longest-wavelength|lowest-energy)?\s*absorption\s+max(?:imum)?\s*",
        "λmax ",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(r"^λabs\s+", "λmax ", s, flags=re.IGNORECASE)
    s = re.sub(r"\bε\s+at\s+(\d+(?:\.\d+)?)\s*nm\s*=\s*", r"ε(\1) ", s, flags=re.IGNORECASE)
    s = re.sub(r"\(ε\s*=\s*", "(ε ", s)
    s = re.sub(r"\b1\s*[×x]\s*10⁻⁴\s*M\b", "10⁻⁴ M", s)
    s = re.sub(r"\bCH3CN\b", "MeCN", s)
    s = re.sub(r"\bacetonitrile\b", "MeCN", s, flags=re.IGNORECASE)
    s = re.sub(r",\s*MeCN$", " (MeCN)", s)
    s = re.sub(r"\s{2,}", " ", s).strip(" .;")
    return s[:120] or None


def clean_direct_exc(val: str | None) -> str | None:
    """Normalise direct excitation note into a concise wavelength/source token."""
    if not val:
        return None
    s = re.sub(r"\s+", " ", val.strip()).rstrip(".")
    s = re.sub(
        r"^the\s+paper\s+(?:excites\s+(?:the\s+complex|it)\s+with\s+(?:a\s+)?|"
        r"irradiates\s+(?:these\s+catalysts|the\s+sample|it)\s+at\s+)",
        "",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(r"^(?:irradiated|excited)\s+at\s+", "", s, flags=re.IGNORECASE)
    return s.strip()[:80] or None


_ET_TYPE_MAP: dict[str, tuple[str, str | None]] = {
    "Estimated from the 77 K emission maximum, using the offset between first vibronic band and maximum found for C1": (
        "77 K emission max (est. 0-0)",
        "Estimated using offset between 0-0 band and max found for C1.",
    ),
    "From the phosphorescence spectrum; the paper does not say whether the 0-0 band or the onset was used": (
        "Phosphorescence (0-0/onset unstated)",
        None,
    ),
    "From the phosphorescence spectrum; band used not stated in the main text": (
        "Phosphorescence (band unstated)",
        None,
    ),
    "From the 77 K emission; the band used is not stated in the main text": (
        "77 K emission (band unstated)",
        None,
    ),
    "From the phosphorescence spectrum (maximum near 450 nm)": (
        "Phosphorescence (~450 nm max)",
        None,
    ),
    "From the highest-energy vibronic band of the 77 K emission": (
        "77 K emission, 0-0 band",
        None,
    ),
    "From the highest-energy emission peak at 77 K": (
        "77 K emission, highest-energy peak",
        None,
    ),
    "Computed; the paper does not say whether vertical or adiabatic": (
        "Computed (type unstated)",
        None,
    ),
    "Computed; the caption does not say whether vertical or adiabatic": (
        "Computed (type unstated)",
        None,
    ),
    "Computed, adiabatic (ΔG between optimised T1 and S0)": (
        "Computed, adiabatic (ΔG)",
        None,
    ),
    "Spectroscopic: 0,0 band or longest-wavelength S0→T1 absorption": (
        "Spectroscopic, 0-0 band",
        None,
    ),
    "Room-temperature emission maximum (not the 0-0 band)": (
        "Emission max (rt, vertical)",
        None,
    ),
    "Not stated per compound": (
        "Not stated",
        None,
    ),
}


def clean_et_type(val: str | None) -> tuple[str | None, str | None]:
    if not val:
        return None, None
    s = re.sub(r"\s+", " ", val.strip())
    if s in _ET_TYPE_MAP:
        return _ET_TYPE_MAP[s]
    # Generic shortening keeping ^Computed prefix intact for score.js
    s = re.sub(r";\s*the\s+(?:paper|caption)\s+does\s+not\s+say\s+whether\s+", " (", s, flags=re.IGNORECASE)
    if "(" in s and ")" not in s:
        s = re.sub(r"was used$", "unstated)", s)
        if ")" not in s:
            s += " unstated)"
    return s[:80], None


_METHOD_MAP: dict[str, tuple[str, str | None]] = {
    "DFT, M06-2X/6-31G(d), as stated in the caption of Figure 3; the authors' data file gives MIDI! as the optimisation basis": (
        "DFT, M06-2X/6-31G(d)",
        "Figure 3 caption states M06-2X/6-31G(d); authors' data file gives MIDI! as optimisation basis.",
    ),
    "DFT, ωB97X-D/6-311G(d,p). The functional reads “B97X-D” in the text extracted from the PDF; ωB97X-D is assumed.": (
        "DFT, ωB97X-D/6-311G(d,p)",
        "PDF text reads 'B97X-D'; ωB97X-D assumed.",
    ),
    "Triplet energy-transfer rate constants from thioxanthone- and Ir-based sensitizers (laser flash photolysis), fitted with a thermal activation model for endothermic transfer": (
        "EnT kinetics (LFP, thermal activation fit)",
        "Rate constants measured against thioxanthone- and Ir-based sensitizers.",
    ),
    "DFT, ωB97X-D4/def2-TZVP (optimisation, frequencies) // def2-TZVPP single point": (
        "DFT, ωB97X-D4/def2-TZVPP // def2-TZVP",
        None,
    ),
    "Phosphorescence spectra, as stated for the whole figure": ("Phosphorescence", None),
    "Emission (phosphorescence) spectroscopy in a frozen matrix": ("Phosphorescence (matrix)", None),
    "Emission (phosphorescence) spectroscopy in a glassy matrix": ("Phosphorescence (glass)", None),
    "Phosphorescence emission spectroscopy": ("Phosphorescence", None),
    "Phosphorescence spectra": ("Phosphorescence", None),
    "Luminescence (phosphorescence) spectroscopy": ("Phosphorescence", None),
    "Heavy-atom perturbed S0→T1 absorption (methyl iodide as perturber)": ("S0→T1 absorption (MeI perturbed)", None),
    "Magnetically perturbed S0→T1 absorption spectroscopy": ("S0→T1 absorption (magnetic)", None),
    "Time-resolved photoacoustic calorimetry, sensitised by benzophenone": ("PAC (benzophenone sensitized)", None),
    "Time-resolved photoacoustic calorimetry, sensitised by xanthone": ("PAC (xanthone sensitized)", None),
    "Time-resolved photoacoustic calorimetry, direct excitation": ("PAC (direct excitation)", None),
    "Time-resolved photoacoustic calorimetry (PAC)": ("Photoacoustic calorimetry (PAC)", None),
}


def clean_method(val: str | None) -> tuple[str | None, str | None]:
    if not val:
        return None, None
    s = re.sub(r"\s+", " ", val.strip())
    if s in _METHOD_MAP:
        return _METHOD_MAP[s]
    return s[:120], None


_CONDITIONS_MAP: dict[str, tuple[str, str | None]] = {
    "Room temperature (stated for all experimental values in the caption of Figure 3)": (
        "rt",
        "Room temperature stated in Figure 3 caption.",
    ),
    "77 K; the solvent or glass is not given in the main text (see the SI)": (
        "77 K (solvent in SI)",
        None,
    ),
    "Solution, room temperature; solvent given in the SI": (
        "Solution, rt (solvent in SI)",
        None,
    ),
    "Solvent model not stated in the table footnote": ("Not stated", None),
    "Cryogenic temperature; solvent or glass not given": ("Cryogenic (solvent unstated)", None),
    "Under high-pressure O2; the example spectra are in CHCl3 at 30 atm O2": ("CHCl3, 30 atm O2", None),
    "CH3CN solid matrix, 77 K (neutral form of the catalyst, no base)": (
        "MeCN matrix, 77 K (neutral)",
        None,
    ),
    "2-Methyltetrahydrofuran glass, 77 K": ("2-MeTHF glass, 77 K", None),
    "2-Methyltetrahydrofuran, 77 K": ("2-MeTHF, 77 K", None),
    "Methylcyclohexane glass, 77 K": ("MCH glass, 77 K", None),
    "Acetonitrile, 25 μM, room temperature": ("MeCN (25 μM), rt", None),
    "Solution in methyl iodide": ("MeI", None),
}


def clean_conditions(val: str | None) -> tuple[str | None, str | None]:
    if not val:
        return None, None
    s = re.sub(r"\s+", " ", val.strip())
    if s in _CONDITIONS_MAP:
        return _CONDITIONS_MAP[s]
    s = re.sub(r"\broom\s+temperature\b", "rt", s, flags=re.IGNORECASE)
    return s[:120], None


def _append_note(existing: str | None, note: str | None) -> str | None:
    if not note:
        return existing
    if not existing:
        return note
    if note.rstrip(".") in existing:
        return existing
    return f"{existing.rstrip()} {note}"


def normalize_row_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a DB/batch entry dict with structured uv/direct_exc & concise text fields."""
    out = dict(row)
    if "uv_lmax" in out or "uv_eps" in out or "uv_cond" in out:
        lmax = int(out["uv_lmax"]) if out.get("uv_lmax") is not None else None
        eps = int(out["uv_eps"]) if out.get("uv_eps") is not None else None
        cond = (str(out["uv_cond"]).strip()[:120] or None) if out.get("uv_cond") else None
        out.pop("uv", None)
    else:
        lmax, eps, cond = parse_uv_fields(out.pop("uv", None))
    out["uv_lmax"] = lmax
    out["uv_eps"] = eps
    out["uv_cond"] = cond
    out["direct_exc"] = parse_direct_exc(out.get("direct_exc"))

    et_t, n1 = clean_et_type(out.get("et_type"))
    meth, n2 = clean_method(out.get("method"))
    cond_txt, n3 = clean_conditions(out.get("conditions"))
    out["et_type"] = et_t
    out["method"] = meth
    out["conditions"] = cond_txt

    vn = out.get("verify_note")
    for extra in (n1, n2, n3):
        vn = _append_note(vn, extra)
    if "verify_note" in out or vn:
        out["verify_note"] = vn
    return out


def audit_conciseness(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Find overly verbose or unparsed values across structured DB fields."""
    issues: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        ident = r.get("import_key") or r.get("id") or r.get("name") or f"row[{i}]"
        if r.get("uv"):
            issues.append({"entry": ident, "field": "uv", "len": len(str(r["uv"])), "value": r["uv"]})
        if r.get("direct_exc") is not None and not isinstance(r.get("direct_exc"), dict):
            issues.append(
                {"entry": ident, "field": "direct_exc", "len": len(str(r["direct_exc"])), "value": r["direct_exc"]}
            )
        for field, limit in FIELD_SOFT_LIMITS.items():
            val = r.get(field)
            if not isinstance(val, str) or not val.strip():
                continue
            if len(val) > limit or _PROSE_PREFIX_RE.search(val.strip()):
                issues.append({"entry": ident, "field": field, "len": len(val), "value": val})
    return issues
