"""Deterministic, no-LLM PDF extraction pipeline for TrEnDB."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from . import clean_fields, scoring
from .models import KCAL_PER_EV, KJ_PER_KCAL
from .resolvers import Resolver, looks_like_anonymous_label, normalize_name_key
from .textnorm import normalize_cell, normalize_text

# Optional PyMuPDF / pdfplumber backends
try:  # pragma: no cover - optional runtime dependency
    import fitz  # type: ignore
except ImportError:  # pragma: no cover
    fitz = None

try:  # pragma: no cover - optional runtime dependency
    import pdfplumber  # type: ignore
except ImportError:  # pragma: no cover
    pdfplumber = None

_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_ANY_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>\]\[),;]+")
_ACS_PDF_URL_RE = re.compile(
    r"pubs\.acs\.org/[^/\s]+/article-pdf/(?:[^/\s]+/)+([a-z]{2}\d{4,}[a-z]\d{3}|[a-z]+\.[a-z0-9]+)\.pdf",
    re.IGNORECASE,
)
_ACS_STEM_RE = re.compile(r"^([a-z]{2}\d{5}a\d{3}|(?:jacs|joc|orglett|jo|ol|cm|jp)\.[a-z0-9]+)$", re.IGNORECASE)
_CAS_INLINE_RE = re.compile(r"\b(\d{2,7}-\d{2}-\d)\b")

# Energy extraction patterns
_UNIT_PATTERN = (
    r"(kcal\s*(?:/|per)\s*mole?|kcal[\s·.]*mole?\s*[-−–]\s*1|"
    r"kJ\s*(?:/|per)\s*mole?|kJ[\s·.]*mole?\s*[-−–]\s*1|eV|cm\s*[-−–]\s*1)"
)
KCAL_PER_WAVENUMBER = 2.85914e-3
_ET_AFTER_CUE_RE = re.compile(
    r"(?:triplet(?:\s+state)?(?:\s+excitation)?\s+energ(?:y|ies)|E_?\s*T\b|T_?\s*1(?:\s+energy)?|"
    r"0\s*[-–]\s*0\s+transition(?:\s+to\s+the\s+lowest\s+triplet\s+state)?|"
    r"(?:vertical|adiabatic)\s+excitation\s+energy|"
    r"0\s*[-–]\s*0\s+band(?:s)?(?:\s*\([^)]+\))?)"
    r"(?:[^.;\n]|\.(?=\d)){0,85}?(?:=|is|of|at|:|~|≈|as|about)?\s*"
    rf"(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?)\s*)?{_UNIT_PATTERN}\b",
    re.IGNORECASE,
)
_ET_BEFORE_CUE_RE = re.compile(
    rf"(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?)\s*)?{_UNIT_PATTERN}"
    r"(?:[^.;\n]|\.(?=\d)){0,45}?\b(?:triplet(?:\s+state)?(?:\s+energy|energies)|E_?\s*T|T_?\s*1)\b",
    re.IGNORECASE,
)
_PHOS_NM_RE = re.compile(
    r"(?:triplet\s+emission|phosphorescence(?:\s+0\s*[-–]\s*0)?(?:\s+band|\s+maximum|\s+peak|\s+onset)?)"
    r"[^.;\n]{0,45}?\b(\d{3}(?:\.\d+)?)\s*nm\b",
    re.IGNORECASE,
)
_VAL_ONLY_RE = re.compile(
    rf"^\s*(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?))?\s*(?:{_UNIT_PATTERN}|(nm))?\s*$",
    re.IGNORECASE,
)
_TABLE_VAL_RE = re.compile(
    rf"^\s*(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?))?\s*(?:{_UNIT_PATTERN}|(nm))?"
    r"(?:\s*[\^*†‡§'·]*[a-z](?:,[a-z])?|\s*[*†‡§]+)?\s*$",
    re.IGNORECASE,
)

# Method / condition / UV regexes
_CALC_HINT_RE = re.compile(
    r"\b(?:DFT|TD-?DFT|B3LYP|ωB97X-?D4?|wB97X-?D4?|M06-?2X|CAM-B3LYP|PBE0|MN15|TPSSh|r2SCAN-3c|"
    r"CASSCF|CCSD\(T\)|MRCI|comput(?:ed|ational)|calculat(?:ed|ion))\b",
    re.IGNORECASE,
)
_EXP_HINT_RE = re.compile(
    r"\b(?:phosphorescence|photoacoustic|PAC\b|EELS|electron-energy-loss|quenching|bracketing|"
    r"sensitization|emission|77\s*°?\s*K|glass|measured|experimental|luminescence|TRIR|"
    r"singlet[-–]triplet\s+absorption|S0\s*(?:→|->)\s*T1|oxygen\s+pressure|Saltiel\s+plot|kinetic\s+spectrophotometry)\b",
    re.IGNORECASE,
)
_FUNC_RE = re.compile(
    r"\b(ωB97X-?D4?|wB97X-?D4?|CAM-B3LYP|B3LYP(?:-D3(?:BJ)?)?|M06-?2X|PBE0|MN15|TPSSh|r2SCAN-3c|CCSD\(T\)|CASSCF)\b",
    re.IGNORECASE,
)
_BASIS_RE = re.compile(
    r"\b(aug-cc-pV[DTQ]Z|cc-pV[DTQ]Z|def2-[STQ]ZVPP?D?|6-311\+?G\([^)]+\)|6-31\+?\+?G\([^)]+\)|6-31G\*+|LANL2DZ)\b"
)
_SOLV_MODEL_RE = re.compile(r"\b(IEF-?PCM|CPCM|PCM|SMD|COSMO|gas\s+phase)\b", re.IGNORECASE)
_TEMP_RE = re.compile(r"\b(\d{1,3}(?:\.\d+)?\s*°?\s*[KC]|room\s+temperature|r\.?t\.?)\b", re.IGNORECASE)
_SOLVENT_RE = re.compile(
    r"\b(methylcyclohexane(?:\s+glass)?|2-?MeTHF|MCH|MCIP|EPA|solid\s+argon|MeCN|acetonitrile|"
    r"CD3CN|CH2Cl2|DCM|dichloromethane|CHCl3|chloroform|CDCl3|THF|toluene|benzene|cyclohexane|"
    r"n-?heptane|heptane|isopentane|methanol|MeOH|ethanol|EtOH|Et2O|diethyl\s+ether|DMSO(?:-d6)?|DMF|CCl4|hexane|water)\b",
    re.IGNORECASE,
)
_UV_RE = re.compile(
    r"(?:UV[-–\s]?vis|absorption(?:\s+max(?:imum)?)?|λ_?\s*max)\s*(?:at|=|:|of)?\s*[^.;\n]{0,45}?\b\d{3}(?:\.\d+)?\s*nm\b",
    re.IGNORECASE,
)
_SECTION_RE = re.compile(
    r"^\s*(Abstract|Introduction|Results(?:\s+and\s+Discussion)?|Discussion|Conclusion[s]?|"
    r"Experimental(?:\s+Section)?|Computational\s+Details|Methods|Supporting\s+Information)\b",
    re.IGNORECASE,
)
_CHEM_NAME_RE = re.compile(
    r"\b(?:[EZRS]-|\([EZRS]\)-|(?:\d+,)*\d+-)?[A-Za-z0-9,'′′\[\]()\-]*"
    r"(?:thioxanthone|xanthone|benzophenone|acetophenone|fluorenone|benzanthrone|coumarin|chalcone|"
    r"stilbene|styrene|anthracene|naphthalene|phenanthrene|pyrene|perylene|chrysene|triphenylene|"
    r"acridine|carbazole|binaphthyl|benzanthracene|dibenzanthracene|benzpyrene|diphenylpropene|"
    r"acetonaphthone|benzil|quinone|duroquinone|flavin|enone|boronate|biphenyl|biacetyl|azide|oxime|acrylate|"
    r"Ir\([^)]+\)[^,\s;]*|Ru\([^)]+\)[^,\s;]*)\b"
)


@dataclass
class PageText:
    page_num: int
    text: str
    layout_text: str
    tables: list[list[list[str]]] = field(default_factory=list)


@dataclass
class PdfDocument:
    path: Path
    metadata_doi: str | None
    pages: list[PageText]
    backend: str


@dataclass
class ExtractedCandidate:
    """Intermediate extracted entry before or after chemical resolution."""

    name: str
    et_kcal: float
    et_unc: float | None
    et_reported: str
    origin: str
    et_type: str
    method: str
    conditions: str
    doi: str | None
    citation: str | None
    location: str
    quote: str | None
    evidence: str | None
    verify_level: str
    verify_note: str
    uv_lmax: int | None = None
    uv_eps: int | None = None
    uv_cond: str | None = None
    cas: str | None = None
    smiles: str | None = None
    smiles_checked: bool = False
    structure_note: str | None = None
    cls: str | None = None
    role: str = "acceptor"
    direct_exc: dict[str, int] | None = None
    source_kind: str = "literature"
    unit: str = "kcal"
    raw_et: float | None = None
    raw_unc: float | None = None
    # Review / diagnostic metadata (never leaked into final batch JSON rows)
    tech: str | None = None
    solvent: str | None = None
    temp: str | None = None
    func: str | None = None
    basis: str | None = None
    solv: str | None = None
    resolution_source: str = ""
    warnings: list[str] = field(default_factory=list)
    pdf_file: str = ""
    page_num: int = 1


class PdfReadError(RuntimeError):
    """A PDF that cannot be turned into text (corrupt, encrypted, or scanned with no OCR available)."""


def _strip_urls(text: str | None) -> str | None:
    if text is None:
        return None
    cleaned = _URL_RE.sub("", text)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned or None


def _truncate_quote(text: str | None, max_words: int = 22) -> str | None:
    if not text:
        return None
    cleaned = _strip_urls(re.sub(r"\s+", " ", text).strip())
    if not cleaned:
        return None
    words = cleaned.split()
    if len(words) > max_words:
        cleaned = " ".join(words[:max_words])
    return cleaned[:300]


def _normalize_unit(unit_raw: str | None) -> str:
    u = (unit_raw or "").lower().replace(" ", "")
    if u.startswith("cm"):
        return "cm"
    if "kj" in u:
        return "kj"
    if "ev" in u:
        return "ev"
    if "nm" in u:
        return "nm"
    return "kcal"


def _convert_energy(val: float, unc: float | None, unit: str) -> tuple[float | None, float | None, str]:
    if unit == "kcal":
        kcal = scoring.round1(val)
        unc_kcal = scoring.round2(abs(unc)) if unc is not None else None
        rep = f"{val:g}" + (f" ± {unc:g}" if unc is not None else "") + " kcal/mol"
        return kcal, unc_kcal, rep
    if unit == "kj":
        kcal = scoring.round1(val / KJ_PER_KCAL)
        unc_kcal = scoring.round2(abs(unc) / KJ_PER_KCAL) if unc is not None else None
        rep = f"{val:g}" + (f" ± {unc:g}" if unc is not None else "") + " kJ/mol"
        return kcal, unc_kcal, rep
    if unit == "ev":
        kcal = scoring.round1(val * KCAL_PER_EV)
        unc_kcal = scoring.round2(abs(unc) * KCAL_PER_EV) if unc is not None else None
        rep = f"{val:g}" + (f" ± {unc:g}" if unc is not None else "") + " eV"
        return kcal, unc_kcal, rep
    if unit == "nm":
        if val <= 0:
            return None, None, ""
        kcal = scoring.round1(28591.5 / val)
        rep = f"{val:g} nm (phosphorescence)"
        return kcal, None, rep
    if unit == "cm":
        kcal = scoring.round1(val * KCAL_PER_WAVENUMBER)
        unc_kcal = scoring.round2(abs(unc) * KCAL_PER_WAVENUMBER) if unc is not None else None
        rep = f"{val:g}" + (f" ± {unc:g}" if unc is not None else "") + " cm-1"
        return kcal, unc_kcal, rep
    return None, None, ""


_THOUSANDS_RE = re.compile(r"^\d{1,3},\d{3}$")


def _num(raw: str | None, unit: str) -> float:
    """Parse a reported value; wavenumbers use the comma as a thousands separator (21,300 cm-1)."""
    txt = (raw or "").strip()
    if unit == "cm" and _THOUSANDS_RE.match(txt):
        txt = txt.replace(",", "")
    return scoring.num(txt)


def _scoring_unit(unit: str) -> str:
    """Units the scorer does not know (nm, cm-1) are stored already converted to kcal/mol."""
    return unit if unit in ("kcal", "kj", "ev") else "kcal"


def normalize_document(doc: "PdfDocument") -> "PdfDocument":
    """Normalise every page of a document in place (idempotent)."""
    for page in doc.pages:
        page.text = normalize_text(page.text)
        page.layout_text = normalize_text(page.layout_text)
        page.tables = [[[normalize_cell(c) for c in row] for row in tb] for tb in page.tables]
    return doc


def _parse_layout_tables(layout_text: str) -> list[list[list[str]]]:
    """Heuristically extract whitespace-aligned tables from pdftotext -layout output."""
    tables: list[list[list[str]]] = []
    cur: list[list[str]] = []
    blank_run = 0
    for raw in layout_text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            blank_run += 1
            if blank_run >= 2 and len(cur) >= 2:
                tables.append(cur)
                cur = []
            continue
        blank_run = 0
        cols = [c.strip() for c in re.split(r"\s{2,}", line.strip()) if c.strip()]
        if len(cols) >= 2:
            cur.append(cols)
        else:
            if len(cur) >= 2:
                tables.append(cur)
            cur = []
    if len(cur) >= 2:
        tables.append(cur)
    return tables


def read_pdf(path: str | Path) -> PdfDocument:
    """Read a PDF using PyMuPDF+pdfplumber when installed, else Poppler pdftotext+pdfinfo."""
    pdf_path = Path(path)
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    if fitz is not None:  # pragma: no cover - used when pymupdf is installed
        try:
            doc = fitz.open(str(pdf_path))
        except Exception as exc:
            raise PdfReadError(f"{pdf_path.name}: not a readable PDF ({exc})") from exc
        if getattr(doc, "needs_pass", False):
            doc.close()
            raise PdfReadError(f"{pdf_path.name}: PDF is password-protected")
        meta = doc.metadata or {}
        meta_doi = None
        for v in meta.values():
            if isinstance(v, str):
                m = _ANY_DOI_RE.search(v)
                if m:
                    cand = scoring.clean_doi(m.group(0))
                    if scoring.is_doi(cand):
                        meta_doi = cand
                        break
        plumber_doc = pdfplumber.open(str(pdf_path)) if pdfplumber is not None else None
        pages: list[PageText] = []
        try:
            for idx, page in enumerate(doc):
                text = page.get_text("text") or ""
                layout_text = page.get_text("text", sort=True) or text
                tables: list[list[list[str]]] = []
                if plumber_doc is not None:
                    for tb in plumber_doc.pages[idx].extract_tables() or []:
                        cleaned = [[(c or "").replace("\n", " ").strip() for c in row] for row in tb if row]
                        if len(cleaned) >= 2:
                            tables.append(cleaned)
                if not tables and hasattr(page, "find_tables"):
                    try:
                        for tb in page.find_tables().tables:
                            ext = tb.extract()
                            cleaned = [[(c or "").replace("\n", " ").strip() for c in row] for row in ext if row]
                            if len(cleaned) >= 2:
                                tables.append(cleaned)
                    except Exception:
                        pass
                if not tables:
                    tables = _parse_layout_tables(layout_text)
                pages.append(PageText(page_num=idx + 1, text=text, layout_text=layout_text, tables=tables))
        finally:
            if plumber_doc is not None:
                plumber_doc.close()
            doc.close()
        return normalize_document(PdfDocument(path=pdf_path, metadata_doi=meta_doi, pages=pages, backend="pymupdf"))

    # Poppler fallback (`pdftotext` + `pdfinfo`)
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        raise RuntimeError(
            "No PDF backend available. Install `pymupdf` & `pdfplumber` (via conda/pip) or ensure Poppler `pdftotext` is on PATH."
        )
    meta_doi = None
    pdfinfo = shutil.which("pdfinfo")
    if pdfinfo:
        info_out = subprocess.run([pdfinfo, str(pdf_path)], capture_output=True, text=True, check=False).stdout
        m = _ANY_DOI_RE.search(info_out)
        if m:
            cand = scoring.clean_doi(m.group(0))
            if scoring.is_doi(cand):
                meta_doi = cand

    def _pdftotext(*flags: str) -> str:
        proc = subprocess.run([pdftotext, *flags, str(pdf_path), "-"], capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip().splitlines()
            reason = detail[-1] if detail else f"pdftotext exit code {proc.returncode}"
            if "password" in reason.lower():
                reason = "PDF is password-protected"
            raise PdfReadError(f"{pdf_path.name}: {reason}")
        return proc.stdout

    raw_plain = _pdftotext()
    raw_layout = _pdftotext("-layout")

    plain_pages = raw_plain.split("\f")
    layout_pages = raw_layout.split("\f")
    # pdftotext trails with an empty string after the final form feed
    if plain_pages and not plain_pages[-1].strip():
        plain_pages.pop()
    if layout_pages and not layout_pages[-1].strip():
        layout_pages.pop()

    n_pages = max(len(plain_pages), len(layout_pages), 1)
    pages = []
    for i in range(n_pages):
        p_txt = plain_pages[i] if i < len(plain_pages) else ""
        l_txt = layout_pages[i] if i < len(layout_pages) else p_txt
        pages.append(PageText(page_num=i + 1, text=p_txt, layout_text=l_txt, tables=_parse_layout_tables(l_txt)))
    return normalize_document(PdfDocument(path=pdf_path, metadata_doi=meta_doi, pages=pages, backend="poppler"))


def _parse_gfm_tables(md_text: str) -> tuple[list[list[list[str]]], str]:
    """Extract GitHub-flavored Markdown tables and return (tables, text_without_tables)."""
    tables: list[list[list[str]]] = []
    kept_lines: list[str] = []
    lines = md_text.splitlines()
    i = 0
    sep_re = re.compile(r"^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$")
    while i < len(lines):
        ln = lines[i]
        if "|" in ln and ln.strip().startswith("|") and i + 1 < len(lines) and sep_re.match(lines[i + 1]):
            tb: list[list[str]] = []
            j = i
            while j < len(lines) and "|" in lines[j] and lines[j].strip().startswith("|"):
                if not sep_re.match(lines[j]):
                    cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                    if any(cells):
                        tb.append(cells)
                j += 1
            if len(tb) >= 2:
                tables.append(tb)
            if kept_lines and re.match(r"^\s*#{1,6}\s*Table\s*\(p\.", kept_lines[-1], re.IGNORECASE):
                kept_lines.pop()
            i = j
            continue
        kept_lines.append(ln)
        i += 1
    return tables, "\n".join(kept_lines)


def read_markdown(path: str | Path) -> PdfDocument:
    """Read a Markdown document (e.g. from `trendb-extract to-md`) into a PdfDocument."""
    md_path = Path(path)
    if not md_path.is_file():
        raise FileNotFoundError(f"Markdown not found: {md_path}")
    raw = md_path.read_text(encoding="utf-8")
    chunks = re.split(r"<!--\s*page\s+(\d+)\s*-->", raw)
    pages: list[PageText] = []
    if len(chunks) > 1:
        for idx in range(1, len(chunks), 2):
            pno = int(chunks[idx])
            body = chunks[idx + 1] if idx + 1 < len(chunks) else ""
            body = re.sub(r"\n---\s*$", "", body.strip())
            gfm_tables, clean_txt = _parse_gfm_tables(body)
            tables = gfm_tables or _parse_layout_tables(clean_txt)
            pages.append(PageText(page_num=pno, text=clean_txt, layout_text=clean_txt, tables=tables))
    else:
        gfm_tables, clean_txt = _parse_gfm_tables(raw)
        tables = gfm_tables or _parse_layout_tables(clean_txt)
        pages.append(PageText(page_num=1, text=clean_txt, layout_text=clean_txt, tables=tables))
    return PdfDocument(path=md_path, metadata_doi=None, pages=pages, backend="markdown")


def detect_doi(doc: PdfDocument) -> str | None:
    """Detect the paper's primary DOI from metadata, filename, opening pages, or ACS PDF codes."""
    if doc.metadata_doi and scoring.is_doi(doc.metadata_doi):
        return doc.metadata_doi

    for p in doc.pages[:2]:
        # Ignore the bibliography section if page 2 already reaches References
        head = re.split(r"\b(?:References|Bibliography|Notes and References)\b", p.text, maxsplit=1)[0]
        for m in _ANY_DOI_RE.finditer(head):
            cand = scoring.clean_doi(m.group(0))
            if scoring.is_doi(cand):
                return cand

    m_fn = _ANY_DOI_RE.search(doc.path.stem.replace("_", "/"))
    if m_fn:
        cand = scoring.clean_doi(m_fn.group(0))
        if scoring.is_doi(cand):
            return cand

    for p in doc.pages[:2]:
        m_acs = _ACS_PDF_URL_RE.search(p.text)
        if m_acs:
            cand = f"10.1021/{m_acs.group(1)}"
            if scoring.is_doi(cand):
                return cand

    m_stem_acs = _ACS_STEM_RE.match(doc.path.stem.strip())
    if m_stem_acs:
        cand = f"10.1021/{m_stem_acs.group(1)}"
        if scoring.is_doi(cand):
            return cand
    return None


def _classify_origin(text: str, default: str = "exp") -> str:
    calc_hits = len(_CALC_HINT_RE.findall(text))
    exp_hits = len(_EXP_HINT_RE.findall(text))
    if calc_hits > exp_hits:
        return "calc"
    if exp_hits > calc_hits:
        return "exp"
    return default


def _extract_method_and_conditions(text: str, origin: str) -> tuple[str, str, str, str | None, str | None, str | None]:
    """Return (et_type, method, conditions, func, basis, solv) for TrEnDB & scoring."""
    func_m = _FUNC_RE.search(text)
    basis_m = _BASIS_RE.search(text)
    solv_model_m = _SOLV_MODEL_RE.search(text)
    solv_m = _SOLVENT_RE.search(text)
    temp_m = _TEMP_RE.search(text)

    if origin == "calc":
        func = func_m.group(1) if func_m else None
        basis = basis_m.group(1) if basis_m else None
        solv_parts = [x for x in (solv_model_m.group(1) if solv_model_m else None, solv_m.group(1) if solv_m else None) if x]
        solv = ", ".join(solv_parts) if solv_parts else None
        if re.search(r"\badiabatic\b", text, re.IGNORECASE):
            et_type = "Computed, adiabatic"
        elif re.search(r"\bvertical\b", text, re.IGNORECASE):
            et_type = "Computed, vertical"
        else:
            et_type = "Computed; vertical or adiabatic not specified"
        method = ", ".join([x for x in ("TD-DFT" if re.search(r"TD-?DFT", text, re.IGNORECASE) else "DFT", func, basis) if x])
        conditions = solv or "Solvent model not stated"
        return et_type, method, conditions, func, basis, solv

    low = text.lower()
    if "phosphorescence" in low:
        tech = "Phosphorescence"
    elif "photoacoustic" in low or re.search(r"\bpac\b", text):
        tech = "Photoacoustic calorimetry"
    elif "electron-energy-loss" in low or "eels" in low:
        tech = "Electron-energy-loss spectroscopy"
    elif (
        "singlet-triplet absorption" in low
        or "singlet–triplet absorption" in low
        or "s0→t1" in low
        or "s0->t1" in low
        or ("absorption" in low and ("o2" in low or "oxygen" in low or "heavy-atom" in low or "mei" in low))
    ):
        tech = (
            "S0→T1 absorption (O2 or heavy-atom perturbed)"
            if ("o2" in low or "oxygen" in low or "heavy-atom" in low or "mei" in low)
            else "S0→T1 absorption"
        )
    elif "quenching" in low or "bracketing" in low or "kinetics" in low or "saltiel" in low or "different plots" in low:
        tech = "Energy-transfer bracketing or quenching kinetics"
    else:
        tech = "Phosphorescence" if re.search(r"\b(?:77|93)\s*°?\s*k\b", low) or "emission" in low else ""

    if re.search(r"\b0\s*[-–]\s*0\b", text):
        et_type = "Spectroscopic, 0-0 band"
    elif re.search(r"\b(?:onset|maximum|vertical)\b", text, re.IGNORECASE):
        et_type = "Spectroscopic, vertical (band onset or maximum)"
    elif re.search(r"\brelaxed\b", text, re.IGNORECASE) or tech == "Photoacoustic calorimetry":
        et_type = "Relaxed triplet"
    elif tech == "Energy-transfer bracketing or quenching kinetics":
        et_type = "From energy-transfer kinetics"
    else:
        et_type = "Other or not stated"

    solvent = solv_m.group(1) if solv_m else None
    temp = re.sub(r"\s*°\s*K$", " K", temp_m.group(1).strip(), flags=re.IGNORECASE) if temp_m else None
    conditions = ", ".join(x for x in (solvent, temp) if x) or "Not stated"
    return et_type, (tech or "Not stated"), conditions, solvent, temp, None


_DIRECT_EXC_RE = re.compile(
    r"(?:irradiat(?:ed|ion)|excit(?:ed|ation)|LED|Kessil|laser)\s*(?:at|with|using|:)?\s*(?:a\s+)?(\d{3,4})\s*nm"
    r"|(\d{3,4})\s*nm\s*(LED|Kessil|laser)\b",
    re.IGNORECASE,
)


def _extract_uv(text: str) -> tuple[int | None, int | None, str | None]:
    m = _UV_RE.search(text)
    if not m:
        return None, None, None
    return clean_fields.parse_uv_fields(_strip_urls(m.group(0).strip()))


def _extract_direct_exc(text: str) -> dict[str, int] | None:
    out: dict[str, int] = {}
    for m in _DIRECT_EXC_RE.finditer(text):
        if m.group(1):
            nm = int(m.group(1))
            src = "LED" if "led" in m.group(0).lower() else ("Kessil" if "kessil" in m.group(0).lower() else ("laser" if "laser" in m.group(0).lower() else "irradiation"))
        else:
            nm = int(m.group(2))
            src = m.group(3)
        if 100 <= nm <= 1500:
            out[src] = nm
    return out or None


def _detect_header_unit(header: str) -> str | None:
    low = header.lower()
    if "kcal" in low:
        return "kcal"
    if re.search(r"\bkj\b", low):
        return "kj"
    if re.search(r"(?<![a-z])ev(?![a-z])", low):
        return "ev"
    if re.search(r"cm\s*[-−–]\s*1", low):
        return "cm"
    if re.search(r"(?<![a-z])nm(?![a-z])", low):
        return "nm"
    return None


_ET_HEADER_CUE_RE = re.compile(r"triplet|(?<![a-z])e_?\s*\(?t\d*\)?(?![a-z])|(?<![a-z])t_?1(?![a-z0-9])", re.IGNORECASE)
_OTHER_ENERGY_HEADER_RE = re.compile(
    r"singlet|fluoresc|(?<![a-z])e_?\s*\(?s\d*\)?(?![a-z])|(?<![a-z])s_?1(?![a-z0-9])|δg|δh|Δg|Δh|"
    r"(?<![a-z])bde(?![a-z])|redox|e\s*1/2|e_?ox|e_?red|barrier|activation|strain",
    re.IGNORECASE,
)
_PROSE_WORD_RE = re.compile(r"\b(?:the|of|to|and|is|are|was|were|that|which|with|for|in|by|this|these)\b", re.IGNORECASE)


def _is_et_header(header: str, table_ctx: str) -> bool:
    """True when a column header denotes a triplet energy.

    A header naming the triplet state is enough. A header carrying only an energy unit counts only
    when the table caption or header row is about triplet energies, and never when it names another
    quantity (singlet energy, redox potential, free energy, ...).
    """
    if _NON_ENERGY_COL_RE.search(header):
        return False
    has_cue = bool(_ET_HEADER_CUE_RE.search(header))
    if _OTHER_ENERGY_HEADER_RE.search(header) and not re.search(r"triplet", header, re.IGNORECASE):
        return False
    if has_cue:
        return True
    return _detect_header_unit(header) in ("kcal", "kj", "ev", "cm") and bool(_TRIPLET_CONTEXT_RE.search(table_ctx))


def _looks_like_prose(cell: str) -> bool:
    words = cell.split()
    return len(words) >= 5 and len(_PROSE_WORD_RE.findall(cell)) >= 2


def _clean_molecule_name(raw: str, resolver: Resolver) -> str:
    """Drop a citation number glued to a known name ("riboflavin83" -> "riboflavin")."""
    m = re.match(r"^(.*[a-z]{4,})(\d{1,3})$", raw)
    if not m:
        return raw
    known = resolver._by_name
    if normalize_name_key(raw) in known:
        return raw
    return m.group(1) if normalize_name_key(m.group(1)) in known else raw


_HEADER_CONT_RE = re.compile(
    r"\b(?:kcal|mole?|kj|ev|nm|temp|solvent|condition|matrix|ref|method|basis|concn|sec-?1|isomer|wavelength)\b",
    re.IGNORECASE,
)
_PURE_NUM_CELL_RE = re.compile(r"^\d{2,3}(?:\.\d+)?(?:\s*[*†‡§]|[a-z])?$", re.IGNORECASE)
_NON_ENERGY_COL_RE = re.compile(
    r"\b(?:concn|conc|wavelength|sec[-−]1|m[-−]1|kq|k1|k_q|k_1|β|beta|filter|lifetime|yield)\b",
    re.IGNORECASE,
)


def _merge_table_header(tb: list[list[str]]) -> tuple[list[str], int]:
    """Merge multi-line table header rows (up to 3 rows) when unit/column labels wrap."""
    header_rows = [tb[0]]
    data_start = 1
    for row in tb[1:3]:
        row_txt = " ".join(c.strip() for c in row if c.strip())
        if not row_txt:
            data_start += 1
            continue
        has_num = any(_PURE_NUM_CELL_RE.match(c.strip()) for c in row if c.strip())
        if not has_num and _HEADER_CONT_RE.search(row_txt):
            header_rows.append(row)
            data_start += 1
        else:
            break
    width = max(len(r) for r in header_rows)
    merged: list[str] = []
    for ci in range(width):
        parts = [r[ci].strip() for r in header_rows if ci < len(r) and r[ci].strip()]
        merged.append(" ".join(parts))
    return merged, data_start


def _clean_cond_cell(val: str) -> str:
    txt = _strip_urls(val.strip()) or ""
    txt = re.sub(r"\s*°\s*K\b", " K", txt, flags=re.IGNORECASE)
    txt = re.sub(r"\^([a-z*†‡§])\b", "", txt, flags=re.IGNORECASE)
    return txt.strip()


def _extract_from_tables(
    doc: PdfDocument,
    *,
    doi: str | None,
    citation: str | None,
    resolver: Resolver,
    default_role: str,
    default_cls: str | None,
) -> list[ExtractedCandidate]:
    results: list[ExtractedCandidate] = []
    for page in doc.pages:
        caption_matches = list(re.finditer(r"(Table\s+(?:S?\d+|[IVX]+)\b[^\n]*)", page.text, re.IGNORECASE))
        # Capture table footnotes mentioning measurement details (e.g. "0-0 band in phosphorescence spectra at 77 K")
        foot_chunks = [
            m.group(0).strip()
            for m in re.finditer(r"[^\n]*(?:0\s*[-–]\s*0\s+band|phosphorescence|triplet\s+energy\s+assignments)[^\n]{0,220}", page.text, re.IGNORECASE)
        ]
        foot_ctx = " ".join(foot_chunks[:3])

        for tb_idx, tb in enumerate(page.tables):
            if len(tb) < 2:
                continue
            header, data_start = _merge_table_header(tb)
            if data_start >= len(tb):
                continue

            cap_match = caption_matches[min(tb_idx, len(caption_matches) - 1)] if caption_matches else None
            table_label = cap_match.group(1).strip()[:80] if cap_match else f"p. {page.page_num}"
            page_ctx = " ".join(x for x in (cap_match.group(1).strip() if cap_match else page.text[:500], foot_ctx) if x)
            preceding_txt = page.text[max(0, cap_match.start() - 500) : cap_match.start()] if cap_match else ""

            name_col: int | None = None
            cas_col: int | None = None
            smiles_col: int | None = None
            method_col: int | None = None
            cond_cols: list[int] = []
            solvent_col: int | None = None
            temp_col: int | None = None
            ref_col: int | None = None
            uv_col: int | None = None
            et_cols: list[tuple[int, str | None, str | None]] = []  # (idx, unit_hint, origin_hint)

            for ci, h in enumerate(header):
                hl = h.lower()
                if name_col is None and any(
                    k in hl for k in ("compound", "molecule", "name", "substance", "sensitizer", "catalyst", "substrate", "donor", "acceptor", "entry")
                ):
                    name_col = ci
                elif cas_col is None and "cas" in hl:
                    cas_col = ci
                elif smiles_col is None and "smiles" in hl:
                    smiles_col = ci
                elif method_col is None and any(k in hl for k in ("method", "functional", "basis", "technique")):
                    method_col = ci
                elif any(k in hl for k in ("solvent", "condition", "matrix", "temp")):
                    cond_cols.append(ci)
                    if "solvent" in hl and solvent_col is None:
                        solvent_col = ci
                    if "temp" in hl and temp_col is None:
                        temp_col = ci
                elif ref_col is None and re.search(r"\bref(?:erence)?s?\b", hl):
                    ref_col = ci
                elif any(k in hl for k in ("uv", "λmax", "lambda", "abs")) and uv_col is None:
                    uv_col = ci
                elif _is_et_header(h, f"{cap_match.group(1) if cap_match else ''} {' '.join(header)}"):
                    origin_hint = "calc" if any(k in hl for k in ("calc", "comp", "dft")) else ("exp" if any(k in hl for k in ("exp", "meas", "obs")) else None)
                    et_cols.append((ci, _detect_header_unit(h), origin_hint))

            if not et_cols:
                continue
            name_col_guessed = name_col is None
            if name_col is None:
                name_col = 0

            for r_idx, row in enumerate(tb[data_start:], start=data_start):
                if name_col >= len(row):
                    continue
                raw_name = re.sub(r"\s*[*†‡§]+$", "", row[name_col].strip()).strip()
                if not raw_name or raw_name.lower() in ("entry", "compound", "substance", "sensitizer", "name", "-", "—"):
                    continue
                # Layout tables often swallow body text: a "name" that reads as a sentence is not a row.
                if _looks_like_prose(raw_name):
                    continue
                # With no name column in the header, a bare number in column 0 is a value, not a label.
                if name_col_guessed and re.fullmatch(r"[\d.,\s±]+", raw_name):
                    continue
                raw_name = _clean_molecule_name(raw_name, resolver)
                name_warnings: list[str] = []
                if re.search(r"[-,(]$", raw_name):
                    name_warnings.append("Name looks truncated (cell wrapped across lines); check the table.")
                # "Pyrene (48.2)": the energy is printed next to the name, the numeric column is something else.
                inline_val = re.search(r"\((\d{2,3}(?:\.\d+)?)\)\s*$", raw_name)
                if inline_val:
                    name_warnings.append(
                        f"Name cell carries a value in parentheses ({inline_val.group(1)}); "
                        "check which number is the triplet energy."
                    )

                row_text = " | ".join(row)
                cas_inline = row[cas_col].strip() if (cas_col is not None and cas_col < len(row)) else None
                if not cas_inline:
                    cm = _CAS_INLINE_RE.search(row_text)
                    cas_inline = cm.group(1) if cm and scoring.cas_valid(cm.group(1)) else None
                raw_smi = row[smiles_col].strip() if (smiles_col is not None and smiles_col < len(row)) else None

                res = resolver.resolve_molecule(raw_name, cas=cas_inline, raw_smiles=raw_smi)

                for ci, unit_hint, origin_hint in et_cols:
                    if ci >= len(row):
                        continue
                    cell = row[ci].strip()
                    vm = _TABLE_VAL_RE.match(cell)
                    if not vm:
                        continue
                    unit = _normalize_unit(vm.group(3) or vm.group(4) or unit_hint)
                    val = _num(vm.group(1), unit)
                    unc = _num(vm.group(2), unit) if vm.group(2) else None
                    et_kcal, unc_kcal, rep = _convert_energy(val, None if unc is None or unc != unc else unc, unit)
                    if et_kcal is None or not (10.0 <= et_kcal <= scoring.ET_MAX):
                        continue

                    cond_parts = [_clean_cond_cell(row[c_i]) for c_i in cond_cols if c_i < len(row) and row[c_i].strip()]
                    ctx_blob = " ".join(
                        [
                            page_ctx,
                            header[ci],
                            row[method_col] if method_col is not None and method_col < len(row) else "",
                            " ".join(cond_parts),
                        ]
                    )
                    if origin_hint:
                        origin = origin_hint
                    elif _CALC_HINT_RE.search(ctx_blob) or _EXP_HINT_RE.search(ctx_blob):
                        origin = _classify_origin(ctx_blob, default="exp")
                    else:
                        origin = _classify_origin(preceding_txt, default="exp")
                    et_type, method, conditions, f_or_solv, b_or_temp, solv_model = _extract_method_and_conditions(ctx_blob, origin)
                    if method_col is not None and method_col < len(row) and row[method_col].strip():
                        method = _strip_urls(row[method_col].strip()) or method
                    if cond_parts:
                        conditions = ", ".join(p for p in cond_parts if p) or conditions
                        if origin != "calc":
                            if not f_or_solv and solvent_col is not None and solvent_col < len(row) and row[solvent_col].strip():
                                f_or_solv = _clean_cond_cell(row[solvent_col]) or None
                            if not b_or_temp and temp_col is not None and temp_col < len(row) and row[temp_col].strip():
                                b_or_temp = _clean_cond_cell(row[temp_col]) or None
                    if uv_col is not None and uv_col < len(row) and row[uv_col].strip():
                        uv_lmax, uv_eps, uv_cond = clean_fields.parse_uv_fields(_strip_urls(row[uv_col].strip()))
                    else:
                        uv_lmax, uv_eps, uv_cond = _extract_uv(row_text)
                    direct_exc = _extract_direct_exc(row_text)
                    ref_val = row[ref_col].strip() if (ref_col is not None and ref_col < len(row) and row[ref_col].strip()) else None
                    v_note = "Automatically extracted from PDF table without LLM; verify structure and values."
                    if ref_val:
                        v_note = f"{v_note} Cited ref in table: {ref_val}."

                    results.append(
                        ExtractedCandidate(
                            name=raw_name[:200],
                            et_kcal=et_kcal,
                            et_unc=unc_kcal,
                            et_reported=rep,
                            origin=origin,
                            et_type=et_type,
                            method=method,
                            conditions=conditions,
                            doi=doi,
                            citation=citation,
                            location=f"{table_label}, row {r_idx} (p. {page.page_num})",
                            quote=_truncate_quote(f"{raw_name}: {header[ci]} = {cell}"),
                            evidence=_strip_urls(f"Extracted from table row: {row_text}"[:400]),
                            verify_level="primaria",
                            verify_note=v_note,
                            uv_lmax=uv_lmax,
                            uv_eps=uv_eps,
                            uv_cond=uv_cond,
                            direct_exc=direct_exc,
                            cas=res.cas,
                            smiles=res.smiles,
                            smiles_checked=False,
                            structure_note=(
                                "Automatically resolved; verify against paper."
                                if res.smiles
                                else "Structure could not be resolved automatically from label/name."
                            ),
                            cls=default_cls or res.cls_hint,
                            role=res.role_hint or default_role,
                            unit=_scoring_unit(unit),
                            raw_et=val if unit in ("kcal", "kj", "ev") else et_kcal,
                            raw_unc=(None if unc is None or unc != unc else unc) if unit in ("kcal", "kj", "ev") else unc_kcal,
                            tech=None if origin == "calc" else (None if method == "Not stated" else method),
                            solvent=None if origin == "calc" else f_or_solv,
                            temp=None if origin == "calc" else b_or_temp,
                            func=f_or_solv if origin == "calc" else None,
                            basis=b_or_temp if origin == "calc" else None,
                            solv=solv_model if origin == "calc" else None,
                            resolution_source=res.source,
                            warnings=[*res.warnings, *name_warnings],
                            pdf_file=doc.path.name,
                            page_num=page.page_num,
                        )
                    )
    return results


_RANGE_OR_NEG_PREFIX_RE = re.compile(
    r"(?:\b(?:between|from|rather\s+than|instead\s+of|more\s+than|less\s+than|below|above|under|over|"
    r"differ(?:s|ence)?\s+by|deficient[^.;\n]{0,25}\bby)\s*|"
    r"\b(?:between|from)\s+\d+(?:[.,]\d+)?\s+(?:and|to)\s*)$",
    re.IGNORECASE,
)
_TRIPLET_CONTEXT_RE = re.compile(
    r"\b(?:triplet|phosphorescence|singlet[-–]triplet|s0\s*(?:→|->)\s*t1|e_?\s*t|t_?\s*1)\b",
    re.IGNORECASE,
)
_PAIR_UNIT_RE = re.compile(
    rf"(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?)\s*)?{_UNIT_PATTERN}\b",
    re.IGNORECASE,
)
_AND_PAIR_UNIT_RE = re.compile(
    rf"(\d+(?:[.,]\d+)?)\s+and\s+(\d+(?:[.,]\d+)?)\s*{_UNIT_PATTERN}\b",
    re.IGNORECASE,
)


_CLAUSE_SPLIT_RE = re.compile(r"[;,]|\b(?:whereas|while|but|and)\b", re.IGNORECASE)
_SINGLET_CUE_RE = re.compile(
    r"\bsinglet\b|\bfluorescence\b|(?<![A-Za-z])S_?\s*1(?![0-9])|(?<![A-Za-z])E_?\s*S(?![A-Za-z])|"
    r"\bS0\s*(?:→|->)\s*S1\b",
    re.IGNORECASE,
)
_TRIPLET_CUE_RE = re.compile(
    r"\btriplet\b|\bphosphorescence\b|(?<![A-Za-z])T_?\s*1(?![0-9])|(?<![A-Za-z])E_?\s*T(?![A-Za-z])",
    re.IGNORECASE,
)


def _clause_around(sent: str, start: int, end: int) -> str:
    """The comma/conjunction-delimited clause that contains sent[start:end]."""
    left = 0
    for m in _CLAUSE_SPLIT_RE.finditer(sent, 0, start):
        left = m.end()
    m_right = _CLAUSE_SPLIT_RE.search(sent, end)
    return sent[left : m_right.start() if m_right else len(sent)]


def _is_singlet_value(sent: str, start: int, end: int) -> bool:
    """True when the value sits in a clause about the singlet state and not the triplet."""
    clause = _clause_around(sent, start, end)
    return bool(_SINGLET_CUE_RE.search(clause)) and not _TRIPLET_CUE_RE.search(clause)


def _find_molecule_spans_in_sentence(sentence: str, resolver: Resolver) -> tuple[list[tuple[int, int, str]], str | None]:
    """Identify non-overlapping candidate molecule spans [(start, end, name), ...] and optional CAS."""
    cas_found: str | None = None
    for cm in _CAS_INLINE_RE.finditer(sentence):
        if scoring.cas_valid(cm.group(1)):
            cas_found = cm.group(1)
            break

    spans: list[tuple[int, int, str]] = []

    def _overlaps(s: int, e: int) -> bool:
        return any(not (e <= a or s >= b) for a, b, _ in spans)

    # 1. Check known names from local TrEnDB / builtin dictionary (longest first)
    low = sentence.lower().replace("′", "'").replace("’", "'")
    low_compact = re.sub(r"\s+", "", low)
    for nk in sorted(resolver._by_name.keys(), key=len, reverse=True):
        if len(nk) < 3 or looks_like_anonymous_label(nk):
            continue
        if nk not in low_compact:
            continue
        # Match flexibly on optional whitespace boundaries between tokens
        pat = r"(?<![A-Za-z0-9])" + r"\s*".join(re.escape(ch) for ch in nk) + r"(?![A-Za-z0-9])"
        for m in re.finditer(pat, low):
            if not _overlaps(m.start(), m.end()):
                spans.append((m.start(), m.end(), sentence[m.start() : m.end()].strip()))

    # 2. Fallback regex chemical names
    for m_chem in _CHEM_NAME_RE.finditer(sentence):
        name_tok = m_chem.group(0).strip(" ,.;:()")
        if len(name_tok) >= 4 and not _overlaps(m_chem.start(), m_chem.end()):
            spans.append((m_chem.start(), m_chem.end(), name_tok))

    # 3. Fallback paper-local anonymous labels ("compound 4a", "sensitizer 1")
    if not spans:
        for m_lbl in re.finditer(
            r"\b((?:compound|compd|substrate|sensitizer|donor|acceptor|complex|catalyst)\s+\d+[a-z]{0,2})\b",
            sentence,
            re.IGNORECASE,
        ):
            spans.append((m_lbl.start(1), m_lbl.end(1), m_lbl.group(1)))

    spans.sort(key=lambda x: x[0])
    return spans, cas_found


def _find_molecule_in_sentence(sentence: str, resolver: Resolver) -> tuple[str, str | None]:
    """Identify primary candidate molecule name and optional inline CAS in a sentence."""
    spans, cas_found = _find_molecule_spans_in_sentence(sentence, resolver)
    return (spans[0][2] if spans else ""), cas_found


def _extract_energy_matches_in_sentence(sent: str) -> list[tuple[int, int, float, float | None, str, str]]:
    """Extract (start, end, val, unc, unit, snippet) energy tuples from one sentence."""
    matches: list[tuple[int, int, float, float | None, str, str]] = []
    for rx, is_nm in ((_ET_AFTER_CUE_RE, False), (_ET_BEFORE_CUE_RE, False), (_PHOS_NM_RE, True)):
        for m in rx.finditer(sent):
            prefix = sent[max(0, m.start() - 45) : m.start()]
            if _RANGE_OR_NEG_PREFIX_RE.search(prefix):
                continue
            if not is_nm and re.search(r"\b0\s*[-–]\s*0\s+band", m.group(0), re.IGNORECASE) and not _TRIPLET_CONTEXT_RE.search(sent):
                continue
            if is_nm:
                val = scoring.num(m.group(1))
                if val == val:
                    matches.append((m.start(1), m.end(), val, None, "nm", m.group(0)))
            else:
                unit = _normalize_unit(m.group(3))
                val = _num(m.group(1), unit)
                unc = _num(m.group(2), unit) if m.group(2) else None
                if val == val and not _is_singlet_value(sent, m.start(1), m.end()):
                    matches.append((m.start(1), m.end(), val, None if unc is None or unc != unc else unc, unit, m.group(0)))
        if matches:
            break

    if not matches:
        return []

    # If the sentence has a triplet energy cue and lists additional values (e.g. "47.0 kcal/mole for A and 45.5 kcal/mole for B"
    # or "at 45.7 and 48.2 kcal/mole, respectively"), pick them up while skipping ranges/rejected values.
    if matches[0][4] != "nm":
        for m in _AND_PAIR_UNIT_RE.finditer(sent):
            prefix = sent[max(0, m.start() - 45) : m.start()]
            if _RANGE_OR_NEG_PREFIX_RE.search(prefix):
                continue
            unit = _normalize_unit(m.group(3))
            v1, v2 = _num(m.group(1), unit), _num(m.group(2), unit)
            if _is_singlet_value(sent, m.start(), m.end()):
                continue
            if v1 == v1 and v2 == v2:
                matches = [x for x in matches if (x[1] <= m.start() or x[0] >= m.end())]
                matches.append((m.start(1), m.end(1), v1, None, unit, m.group(0)))
                matches.append((m.start(2), m.end(2), v2, None, unit, m.group(0)))

        def _covered(s: int, e: int) -> bool:
            return any(not (e <= a or s >= b) for a, b, *_ in matches)

        for m in _PAIR_UNIT_RE.finditer(sent):
            if _covered(m.start(), m.end()):
                continue
            prefix = sent[max(0, m.start() - 45) : m.start()]
            if _RANGE_OR_NEG_PREFIX_RE.search(prefix):
                continue
            unit = _normalize_unit(m.group(3))
            val = _num(m.group(1), unit)
            unc = _num(m.group(2), unit) if m.group(2) else None
            if _is_singlet_value(sent, m.start(), m.end()):
                continue
            if val == val:
                matches.append((m.start(), m.end(), val, None if unc is None or unc != unc else unc, unit, m.group(0)))

    matches.sort(key=lambda x: x[0])
    return matches


def _pair_molecules_to_matches(
    sent: str,
    mol_spans: list[tuple[int, int, str]],
    matches: list[tuple[int, int, float, float | None, str, str]],
) -> list[str]:
    if not mol_spans:
        return ["(unnamed candidate)"] * len(matches)
    if len(mol_spans) == 1:
        return [mol_spans[0][2]] * len(matches)

    assigned: list[str | None] = [None] * len(matches)
    # 1. Explicit "<val> <unit> for <molecule>"
    for i, (ms, me, *_rest) in enumerate(matches):
        next_ms = matches[i + 1][0] if i + 1 < len(matches) else len(sent)
        tail = sent[me : min(next_ms, me + 45)]
        if re.match(r"^\s*(?:for|of)\s+", tail, re.IGNORECASE):
            for a, b, name in mol_spans:
                if me <= a < min(next_ms, me + 45):
                    assigned[i] = name
                    break

    if all(x is not None for x in assigned):
        return [x or "(unnamed candidate)" for x in assigned]

    # 2. Parallel list ("A and B ... at X and Y kcal/mole")
    if len(mol_spans) == len(matches) and all(x is None for x in assigned):
        return [m[2] for m in mol_spans]

    # 3. Nearest molecule span in the sentence
    out: list[str] = []
    for i, (ms, me, *_rest) in enumerate(matches):
        if assigned[i] is not None:
            out.append(assigned[i] or "(unnamed candidate)")
            continue
        best = min(mol_spans, key=lambda sp: 0 if (sp[0] <= ms <= sp[1]) else min(abs(ms - sp[1]), abs(sp[0] - me)))
        out.append(best[2])
    return out


def _extract_from_prose(
    doc: PdfDocument,
    *,
    doi: str | None,
    citation: str | None,
    resolver: Resolver,
    default_role: str,
    default_cls: str | None,
) -> list[ExtractedCandidate]:
    results: list[ExtractedCandidate] = []
    for page in doc.pages:
        cur_section = f"p. {page.page_num}"
        text = re.sub(r"(?<!\bcis)(?<!\btrans)-\n([a-z])", r"\1", page.text)

        # Group consecutive non-blank lines into paragraphs while preserving section headings.
        paragraphs: list[tuple[str, str]] = []
        buf: list[str] = []
        for raw_ln in text.splitlines():
            ln = raw_ln.strip()
            if not ln:
                if buf:
                    paragraphs.append((cur_section, " ".join(buf)))
                    buf = []
                continue
            sec_m = _SECTION_RE.match(ln)
            if sec_m and len(ln) <= 120:
                if buf:
                    paragraphs.append((cur_section, " ".join(buf)))
                    buf = []
                cur_section = sec_m.group(1).strip()
                # If the heading line carries extra text (e.g. "Abstract: Styrene..."), keep it in buf
                rest = ln[sec_m.end() :].lstrip(" :.—-")
                if rest:
                    buf.append(rest)
                continue
            buf.append(ln)
        if buf:
            paragraphs.append((cur_section, " ".join(buf)))

        for sec_label, para in paragraphs:
            joined = re.sub(r"\s+", " ", para)
            sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(])", joined)

            for sent in sentences:
                matches = _extract_energy_matches_in_sentence(sent)
                if not matches:
                    continue

                mol_spans, cas_inline = _find_molecule_spans_in_sentence(sent, resolver)
                paired_names = _pair_molecules_to_matches(sent, mol_spans, matches)

                origin = _classify_origin(sent, default="exp")
                et_type, method, conditions, f_or_solv, b_or_temp, solv_model = _extract_method_and_conditions(sent, origin)
                uv_lmax, uv_eps, uv_cond = _extract_uv(sent)
                direct_exc = _extract_direct_exc(sent)
                is_abs = "abstract" in sec_label.lower() or (page.page_num == 1 and "abstract" in sent[:40].lower())

                resolved_cache: dict[str, Any] = {}
                for (_ms, _me, val, unc, unit, snippet), mol_name in zip(matches, paired_names):
                    et_kcal, unc_kcal, rep = _convert_energy(val, unc, unit)
                    if et_kcal is None or not (10.0 <= et_kcal <= scoring.ET_MAX):
                        continue
                    mol_name = _clean_molecule_name(mol_name, resolver)
                    if mol_name not in resolved_cache:
                        resolved_cache[mol_name] = (
                            resolver.resolve_molecule(mol_name, cas=cas_inline)
                            if mol_name != "(unnamed candidate)"
                            else resolver.resolve_molecule("", cas=cas_inline)
                        )
                    res = resolved_cache[mol_name]
                    results.append(
                        ExtractedCandidate(
                            name=mol_name[:200],
                            et_kcal=et_kcal,
                            et_unc=unc_kcal,
                            et_reported=rep,
                            origin=origin,
                            et_type=et_type,
                            method=method,
                            conditions=conditions,
                            doi=doi,
                            citation=citation,
                            location="Abstract" if is_abs else (sec_label if sec_label == f"p. {page.page_num}" else f"{sec_label}, p. {page.page_num}"),
                            quote=_truncate_quote(snippet),
                            evidence=_strip_urls(sent[:400]),
                            verify_level="abstract" if is_abs else "primaria",
                            verify_note="Automatically extracted from PDF text without LLM; verify structure and values.",
                            uv_lmax=uv_lmax,
                            uv_eps=uv_eps,
                            uv_cond=uv_cond,
                            direct_exc=direct_exc,
                            cas=res.cas,
                            smiles=res.smiles,
                            smiles_checked=False,
                            structure_note=(
                                "Automatically resolved; verify against paper."
                                if res.smiles
                                else "Structure could not be resolved automatically from text."
                            ),
                            cls=default_cls or res.cls_hint,
                            role=res.role_hint or default_role,
                            unit=_scoring_unit(unit),
                            raw_et=val if unit in ("kcal", "kj", "ev") else et_kcal,
                            raw_unc=unc if unit in ("kcal", "kj", "ev") else unc_kcal,
                            tech=None if origin == "calc" else (None if method == "Not stated" else method),
                            solvent=None if origin == "calc" else f_or_solv,
                            temp=None if origin == "calc" else b_or_temp,
                            func=f_or_solv if origin == "calc" else None,
                            basis=b_or_temp if origin == "calc" else None,
                            solv=solv_model if origin == "calc" else None,
                            resolution_source=res.source,
                            warnings=list(res.warnings),
                            pdf_file=doc.path.name,
                            page_num=page.page_num,
                        )
                    )
    return results


def extract_from_document(
    doc: PdfDocument,
    *,
    resolver: Resolver,
    doi_override: str | None = None,
    citation_override: str | None = None,
    default_role: str = "acceptor",
    default_cls: str | None = None,
    enable_ocr: bool = True,
    use_si: bool = True,
    fetch_si: bool = True,
    si_paths: Sequence[str | Path] | None = None,
    si_cache_dir: str | Path | None = ".cache/trendb_si",
) -> list[ExtractedCandidate]:
    """Extract candidate TrEnDB entries from an already-parsed PdfDocument."""
    normalize_document(doc)
    doi = scoring.clean_doi(doi_override) if doi_override else detect_doi(doc)
    if doi and not scoring.is_doi(doi):
        doi = None

    citation = _strip_urls(citation_override)
    if not citation and doi:
        citation = _strip_urls(resolver.fetch_citation(doi))
    if not citation and doc.pages:
        first_line = next((ln.strip() for ln in doc.pages[0].text.splitlines() if len(ln.strip()) > 12), "")
        citation = _strip_urls(first_line[:200])

    table_hits = _extract_from_tables(
        doc,
        doi=doi,
        citation=citation,
        resolver=resolver,
        default_role=default_role,
        default_cls=default_cls,
    )
    prose_hits = _extract_from_prose(
        doc,
        doi=doi,
        citation=citation,
        resolver=resolver,
        default_role=default_role,
        default_cls=default_cls,
    )

    # Deduplicate table vs prose hits on the same molecule/origin/energy
    combined: list[ExtractedCandidate] = list(table_hits)
    seen = {
        (normalize_name_key(c.name), c.origin, round(c.et_kcal, 1))
        for c in table_hits
    }
    for p in prose_hits:
        key = (normalize_name_key(p.name), p.origin, round(p.et_kcal, 1))
        if key not in seen:
            seen.add(key)
            combined.append(p)

    if use_si:
        from .si import enrich_with_si

        combined = enrich_with_si(
            doc,
            combined,
            resolver=resolver,
            doi=doi,
            citation=citation,
            default_role=default_role,
            default_cls=default_cls,
            enable_ocr=enable_ocr,
            fetch_si=fetch_si,
            si_paths=si_paths,
            si_cache_dir=si_cache_dir,
        )
    return combined


def extract_markdown(
    md_path: str | Path,
    *,
    resolver: Resolver,
    doi_override: str | None = None,
    citation_override: str | None = None,
    default_role: str = "acceptor",
    default_cls: str | None = None,
    enable_ocr: bool = True,
    fetch_si: bool = True,
    si_paths: Sequence[str | Path] | None = None,
    si_cache_dir: str | Path | None = ".cache/trendb_si",
) -> list[ExtractedCandidate]:
    """Extract candidate TrEnDB entries from a Markdown document without an LLM."""
    doc = read_markdown(md_path)
    return extract_from_document(
        doc,
        resolver=resolver,
        doi_override=doi_override,
        citation_override=citation_override,
        default_role=default_role,
        default_cls=default_cls,
        enable_ocr=enable_ocr,
        fetch_si=fetch_si,
        si_paths=si_paths,
        si_cache_dir=si_cache_dir,
    )


def extract_pdf(
    pdf_path: str | Path,
    *,
    resolver: Resolver,
    doi_override: str | None = None,
    citation_override: str | None = None,
    default_role: str = "acceptor",
    default_cls: str | None = None,
    enable_ocr: bool = True,
    save_markdown_dir: str | Path | None = None,
    use_decimer: bool = False,
    figures_dir: str | Path | None = None,
    ocsr_predictor: Any = None,
    fetch_si: bool = True,
    si_paths: Sequence[str | Path] | None = None,
    si_cache_dir: str | Path | None = ".cache/trendb_si",
    strict: bool = False,
) -> list[ExtractedCandidate]:
    """Extract candidate TrEnDB entries from a single PDF without an LLM.

    With ``strict`` a PDF that yields no usable text raises PdfReadError instead of returning nothing.
    """
    from .ocsr import decimer_available, run_ocsr_on_pdf
    from .pdf_markdown import pdf_to_markdown

    p_path = Path(pdf_path)
    md_out = Path(save_markdown_dir) / f"{p_path.stem}.md" if save_markdown_dir else None
    doc, _md, _md_pages = pdf_to_markdown(p_path, enable_ocr=enable_ocr, save_path=md_out)
    if strict and sum(len(re.sub(r"\s+", "", pg.text)) for pg in doc.pages) < 200:
        raise PdfReadError(
            f"{p_path.name}: no extractable text (scanned PDF and OCR unavailable, or empty document)"
        )

    combined = extract_from_document(
        doc,
        resolver=resolver,
        doi_override=doi_override,
        citation_override=citation_override,
        default_role=default_role,
        default_cls=default_cls,
        enable_ocr=enable_ocr,
        fetch_si=fetch_si,
        si_paths=si_paths,
        si_cache_dir=si_cache_dir,
    )

    # Optional OCSR via DECIMER-Image_Transformer for unresolved structures
    unresolved = [c for c in combined if not c.smiles]
    if unresolved and (use_decimer or ocsr_predictor is not None or figures_dir is not None):
        target_pages = {c.page_num for c in unresolved}
        fig_out = Path(figures_dir) / p_path.stem if figures_dir else p_path.parent / f".figures_{p_path.stem}"
        run_pred = ocsr_predictor if (ocsr_predictor is not None or (use_decimer and decimer_available())) else None
        figs = run_ocsr_on_pdf(p_path, fig_out, pages=target_pages, predictor=run_pred)
        figs_by_page: dict[int, list[Any]] = {}
        for f in figs:
            figs_by_page.setdefault(f.page_num, []).append(f)

        for cand in unresolved:
            page_figs = figs_by_page.get(cand.page_num, [])
            if not page_figs:
                continue
            matched = None
            cand_tokens = set(re.findall(r"[A-Za-z0-9\-]+", cand.name.lower()))
            for fig in page_figs:
                if fig.label and fig.label.lower() in cand_tokens and fig.predicted_smiles:
                    matched = fig
                    break
            if matched is None:
                pred_figs = [f for f in page_figs if f.predicted_smiles]
                if len(pred_figs) == 1:
                    matched = pred_figs[0]
            if matched and matched.predicted_smiles:
                cand.smiles = matched.predicted_smiles
                cand.resolution_source = "decimer_image_transformer"
                cand.structure_note = (
                    f"Predicted from PDF figure ({matched.image_path.name}) via DECIMER-Image_Transformer; verify drawing."
                )
            else:
                cand.warnings.append(
                    "Cropped figure(s) available for review: " + ", ".join(str(f.image_path) for f in page_figs)
                )

    return combined
