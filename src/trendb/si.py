"""Supporting Information (SI) discovery, safe downloading, parsing, and candidate enrichment."""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import quote, urljoin, urlparse
from xml.etree import ElementTree as ET

import httpx

from . import chem, scoring
from .resolvers import Resolver, looks_like_anonymous_label, normalize_name_key

# Never attempt to bypass gates or CAPTCHAs: detect and abort on challenge/HTML gate responses.
_GATE_HTML_RE = re.compile(
    r"cf-browser-verification|captcha|verify\s+you\s+are\s+human|turnstile|hcaptcha|px-captcha|access\s+denied|institutional\s+login",
    re.IGNORECASE,
)

_SI_REF_RE = re.compile(
    r"\b(?:supporting\s+information|supplementary\s+(?:information|material|data|files?|notes?)|"
    r"electronic\s+supplementary\s+(?:information|material)|ESI\b|"
    r"(?:see|in|details\s+in)\s+(?:the\s+)?SI\b|"
    r"(?:Table|Figure|Fig\.|Scheme|Section|Page)\s+S\d+)\b",
    re.IGNORECASE,
)

_REPO_DOI_RE = re.compile(
    r"\b(10\.(?:5281/zenodo\.\d+|6084/[^\s\"<>\]\[),;]+|5061/dryad\.[^\s\"<>\]\[),;]+|26434/chemrxiv[^\s\"<>\]\[),;]+))\b",
    re.IGNORECASE,
)

_SI_LINK_HINT_RE = re.compile(
    r"(?:support|suppl|supplementary|esi\b|supinfo|suppdata|static-content\.springer\.com/esm|"
    r"mmc\d+\.(?:pdf|docx?|xlsx?|csv|txt|zip)|media-\d+|[_-]si\.(?:pdf|docx?|zip|csv|txt)|/s1(?:[/?#]|$))",
    re.IGNORECASE,
)

_ALLOWED_SI_EXTS = {".pdf", ".md", ".markdown", ".txt", ".docx", ".csv", ".tsv", ".zip"}
_COMPANION_SI_SUFFIXES = ("_si", "-si", "_supp", "-supp", "_supporting", "-supporting", "_esi", "-esi")

_MAX_SI_FILES = 6
_MAX_SI_BYTES = 50 * 1024 * 1024


@dataclass
class SIDownloadResult:
    files: list[Path] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    from_cache: bool = False


class _AnchorParser(HTMLParser):
    """Extract <a href> + text and <meta name="citation_pdf_url"> links from landing pages."""

    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self.meta_pdfs: list[str] = []
        self._cur_href: str | None = None
        self._cur_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "a" and attr_map.get("href"):
            self._cur_href = attr_map["href"].strip()
            self._cur_text = []
        elif t == "meta":
            name = attr_map.get("name", "").lower()
            if name in ("citation_pdf_url", "citation_supplementary_material_url") and attr_map.get("content"):
                self.meta_pdfs.append(attr_map["content"].strip())

    def handle_data(self, data: str) -> None:
        if self._cur_href is not None:
            self._cur_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._cur_href is not None:
            self.links.append((self._cur_href, " ".join(self._cur_text).strip()))
            self._cur_href = None
            self._cur_text = []


def has_si_references(doc: Any) -> tuple[bool, list[str]]:
    """Return (has_si_ref, linked_repository_dois) across the document text."""
    has_ref = False
    linked_dois: list[str] = []
    seen: set[str] = set()
    for page in getattr(doc, "pages", []):
        txt = getattr(page, "text", "") or ""
        if not has_ref and _SI_REF_RE.search(txt):
            has_ref = True
        for m in _REPO_DOI_RE.finditer(txt):
            d = scoring.clean_doi(m.group(1))
            if scoring.is_doi(d) and d.lower() not in seen:
                seen.add(d.lower())
                linked_dois.append(d)
    return has_ref or bool(linked_dois), linked_dois


def candidate_missing_data(c: Any) -> list[str]:
    """Identify key fields missing from an ExtractedCandidate."""
    missing: list[str] = []
    if not c.smiles:
        missing.append("smiles")
    if not c.et_type or c.et_type in ("Other or not stated", "Computed; vertical or adiabatic not specified", "Not stated"):
        missing.append("et_type")
    if c.origin == "calc":
        if not c.func:
            missing.append("func")
        if not c.basis:
            missing.append("basis")
        if not c.solv:
            missing.append("solv")
    else:
        if not c.tech or c.method == "Not stated":
            missing.append("tech")
        if not c.solvent:
            missing.append("solvent")
        if not c.temp:
            missing.append("temp")
    return missing


def should_fetch_si(doc: Any, candidates: list[Any]) -> bool:
    """True when the paper references SI, yields 0 candidates, or has incomplete candidates."""
    if not candidates:
        return True
    has_ref, _ = has_si_references(doc)
    if has_ref:
        return True
    return any(candidate_missing_data(c) for c in candidates)


def find_local_si_files(main_path: Path) -> list[Path]:
    """Find companion SI files in the same directory (e.g. paper_si.pdf, paper-SI.docx)."""
    if not main_path.parent.is_dir():
        return []
    stem_low = main_path.stem.lower()
    matches: list[Path] = []
    for p in sorted(main_path.parent.iterdir()):
        if not p.is_file() or p.resolve() == main_path.resolve():
            continue
        if p.suffix.lower() not in _ALLOWED_SI_EXTS:
            continue
        p_low = p.stem.lower()
        if any(p_low == f"{stem_low}{suf}" or p_low.startswith(f"{stem_low}{suf}_") or p_low.startswith(f"{stem_low}{suf}-") for suf in _COMPANION_SI_SUFFIXES):
            matches.append(p)
    return matches


def _doi_cache_dir(cache_dir: Path, doi: str) -> Path:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", doi).strip("_")[:80] or "si"
    return cache_dir / slug


def _safe_extract_zip(zip_path: Path, dest_dir: Path) -> list[Path]:
    """Safely extract supported SI documents from a ZIP archive (blocking ZipSlip)."""
    extracted: list[Path] = []
    dest_resolved = dest_dir.resolve()
    total_bytes = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            rel = Path(info.filename)
            if rel.is_absolute() or ".." in rel.parts:
                continue
            if rel.suffix.lower() not in (_ALLOWED_SI_EXTS - {".zip"}):
                continue
            if info.file_size > _MAX_SI_BYTES or total_bytes + info.file_size > _MAX_SI_BYTES * 2:
                continue
            target = (dest_dir / rel.name).resolve()
            if not str(target).startswith(str(dest_resolved)):
                continue
            if target.exists():
                target = dest_dir / f"{rel.stem}_{len(extracted) + 1}{rel.suffix}"
            with zf.open(info, "r") as src, target.open("wb") as dst:
                data = src.read(_MAX_SI_BYTES + 1)
                if len(data) > _MAX_SI_BYTES:
                    continue
                total_bytes += len(data)
                dst.write(data)
            extracted.append(target)
            if len(extracted) >= _MAX_SI_FILES:
                break
    return extracted


def _infer_ext(url: str, content_type: str, head_bytes: bytes) -> str:
    if head_bytes.startswith(b"%PDF-"):
        return ".pdf"
    path_ext = Path(urlparse(url).path).suffix.lower()
    if head_bytes.startswith(b"PK\x03\x04"):
        return ".docx" if path_ext == ".docx" or "wordprocessingml" in content_type else ".zip"
    if path_ext in _ALLOWED_SI_EXTS:
        return path_ext
    ct = content_type.lower()
    if "pdf" in ct:
        return ".pdf"
    if "wordprocessingml" in ct:
        return ".docx"
    if "csv" in ct:
        return ".csv"
    if "tab-separated" in ct:
        return ".tsv"
    if "zip" in ct:
        return ".zip"
    if "text/plain" in ct:
        return ".txt"
    return ""


def _discover_zenodo_files(client: httpx.Client, doi: str) -> list[str]:
    m = re.search(r"10\.5281/zenodo\.(\d+)", doi, re.IGNORECASE)
    if not m:
        return []
    try:
        resp = client.get(f"https://zenodo.org/api/records/{m.group(1)}")
        if not resp.is_success:
            return []
        urls: list[str] = []
        for f in resp.json().get("files") or []:
            fname = str(f.get("key") or "")
            link = (f.get("links") or {}).get("self")
            if link and Path(fname).suffix.lower() in _ALLOWED_SI_EXTS:
                urls.append(link)
        return urls
    except Exception:
        return []


def _discover_figshare_files(client: httpx.Client, doi: str) -> list[str]:
    m = re.search(r"10\.6084/m9\.figshare\.(\d+)", doi, re.IGNORECASE)
    if not m:
        return []
    try:
        resp = client.get(f"https://api.figshare.com/v2/articles/{m.group(1)}")
        if not resp.is_success:
            return []
        urls: list[str] = []
        for f in resp.json().get("files") or []:
            fname = str(f.get("name") or "")
            dl = f.get("download_url")
            if dl and Path(fname).suffix.lower() in _ALLOWED_SI_EXTS:
                urls.append(dl)
        return urls
    except Exception:
        return []


def _discover_crossref_and_repos(
    client: httpx.Client,
    doi: str,
    extra_dois: Sequence[str],
) -> tuple[list[str], str | None]:
    """Query Crossref Works API for supplement relations, links, and landing page URL."""
    si_urls: list[str] = []
    landing_url: str | None = None
    all_dois = [doi] + [d for d in extra_dois if d.lower() != doi.lower()]

    for d in all_dois:
        si_urls.extend(_discover_zenodo_files(client, d))
        si_urls.extend(_discover_figshare_files(client, d))

    try:
        resp = client.get(f"https://api.crossref.org/works/{quote(doi, safe='')}")
        if resp.is_success:
            msg = resp.json().get("message") or {}
            landing_url = msg.get("URL") or None
            for lk in msg.get("link") or []:
                u = lk.get("URL")
                if u and (_SI_LINK_HINT_RE.search(u) or str(lk.get("intended-application") or "").lower() == "similarity-checking"):
                    if _SI_LINK_HINT_RE.search(u):
                        si_urls.append(u)
            rels = msg.get("relation") or {}
            for rkey in ("is-supplemented-by", "has-supplement"):
                for item in rels.get(rkey) or []:
                    if item.get("id-type") == "doi" and item.get("id"):
                        rel_doi = scoring.clean_doi(item["id"])
                        si_urls.extend(_discover_zenodo_files(client, rel_doi))
                        si_urls.extend(_discover_figshare_files(client, rel_doi))
                        if not si_urls and scoring.is_doi(rel_doi):
                            si_urls.append(f"https://doi.org/{rel_doi}")
    except Exception:
        pass
    return si_urls, landing_url


def _discover_europepmc_si(client: httpx.Client, doi: str) -> list[str]:
    try:
        resp = client.get(
            "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
            params={"query": f'DOI:"{doi}"', "format": "json", "resultType": "lite"},
        )
        if not resp.is_success:
            return []
        results = ((resp.json().get("resultList") or {}).get("result")) or []
        for rec in results:
            pmcid = rec.get("pmcid")
            if pmcid:
                return [f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/supplementaryFiles"]
    except Exception:
        pass
    return []


def _discover_landing_si_links(client: httpx.Client, url: str) -> tuple[list[str], str | None]:
    """Fetch DOI landing page safely (no anti-bot bypass) and extract SI document links."""
    try:
        resp = client.get(url, follow_redirects=True)
    except Exception as exc:
        return [], f"Could not reach publisher page for SI discovery: {exc.__class__.__name__}"

    if resp.status_code in (401, 403, 429):
        return [], f"Publisher page returned HTTP {resp.status_code}; cannot auto-download SI."
    if not resp.is_success:
        return [], f"Publisher page returned HTTP {resp.status_code}."

    ctype = (resp.headers.get("content-type") or "").lower()
    if "html" not in ctype:
        return ([str(resp.url)] if _SI_LINK_HINT_RE.search(str(resp.url)) else []), None

    body = resp.text[:400_000]
    if _GATE_HTML_RE.search(body):
        return [], "Publisher page is gated by access control or anti-bot verification; supply SI file locally with --si."

    parser = _AnchorParser()
    try:
        parser.feed(body)
    except Exception:
        return [], None

    base_url = str(resp.url)
    found: list[str] = []
    for href, anchor_txt in parser.links:
        if href.startswith(("#", "javascript:", "mailto:")):
            continue
        abs_url = urljoin(base_url, href)
        if not abs_url.startswith(("http://", "https://")):
            continue
        if _SI_LINK_HINT_RE.search(abs_url) or _SI_LINK_HINT_RE.search(anchor_txt):
            path_ext = Path(urlparse(abs_url).path).suffix.lower()
            if not path_ext or path_ext in _ALLOWED_SI_EXTS or "/s1" in abs_url or "suppl" in abs_url.lower():
                found.append(abs_url)
    for murl in parser.meta_pdfs:
        if _SI_LINK_HINT_RE.search(murl):
            found.append(urljoin(base_url, murl))
    return found, None


def download_si_for_doi(
    doi: str,
    *,
    resolver: Resolver,
    extra_dois: Sequence[str] = (),
    cache_dir: str | Path | None = ".cache/trendb_si",
) -> SIDownloadResult:
    """Discover and download Supporting Information files for a DOI using open endpoints."""
    clean_d = scoring.clean_doi(doi)
    if not scoring.is_doi(clean_d) or resolver.offline:
        return SIDownloadResult()

    cdir = _doi_cache_dir(Path(cache_dir or ".cache/trendb_si"), clean_d)
    manifest_path = cdir / "manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            cached_files = [Path(p) for p in manifest.get("files") or [] if Path(p).is_file()]
            if cached_files or manifest.get("attempted"):
                return SIDownloadResult(
                    files=cached_files,
                    warnings=list(manifest.get("warnings") or []),
                    from_cache=True,
                )
        except Exception:
            pass

    client = resolver._http
    warnings: list[str] = []
    candidates, landing = _discover_crossref_and_repos(client, clean_d, extra_dois)
    candidates.extend(_discover_europepmc_si(client, clean_d))

    landing_target = landing or f"https://doi.org/{quote(clean_d, safe='/')}"
    html_links, land_warn = _discover_landing_si_links(client, landing_target)
    if land_warn:
        warnings.append(land_warn)
    candidates.extend(html_links)

    # Deduplicate candidate URLs while preserving order
    unique_urls: list[str] = []
    seen_urls: set[str] = set()
    for u in candidates:
        if u not in seen_urls:
            seen_urls.add(u)
            unique_urls.append(u)

    cdir.mkdir(parents=True, exist_ok=True)
    downloaded: list[Path] = []
    for idx, url in enumerate(unique_urls[: _MAX_SI_FILES * 2], start=1):
        if len(downloaded) >= _MAX_SI_FILES:
            break
        try:
            resp = client.get(url, follow_redirects=True)
        except Exception:
            continue
        if resp.status_code in (401, 403, 429):
            warnings.append(f"SI download declined (HTTP {resp.status_code}); supply file locally with --si.")
            continue
        if not resp.is_success:
            continue

        content = resp.content
        if not content or len(content) > _MAX_SI_BYTES:
            continue
        ctype = (resp.headers.get("content-type") or "").lower()
        if "html" in ctype and not content.lstrip().startswith((b"%PDF-", b"PK\x03\x04")):
            # Do not treat login/landing/challenge HTML as an SI document
            continue
        ext = _infer_ext(str(resp.url), ctype, content[:16])
        if not ext:
            continue

        raw_name = Path(urlparse(str(resp.url)).path).name
        safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(raw_name).stem if raw_name else f"si_{idx}").strip("_")[:60] or f"si_{idx}"
        out_path = cdir / f"{safe_stem}{ext}"
        if out_path.exists():
            out_path = cdir / f"{safe_stem}_{idx}{ext}"
        out_path.write_bytes(content)

        if ext == ".zip":
            downloaded.extend(_safe_extract_zip(out_path, cdir))
        else:
            downloaded.append(out_path)

    manifest_data = {
        "doi": clean_d,
        "attempted": True,
        "files": [str(p) for p in downloaded],
        "warnings": warnings,
    }
    manifest_path.write_text(json.dumps(manifest_data, indent=2, ensure_ascii=False), encoding="utf-8")
    return SIDownloadResult(files=downloaded, warnings=warnings, from_cache=False)


def _read_docx_as_document(path: Path) -> Any:
    """Parse a .docx file's paragraphs and tables into a PdfDocument using stdlib zipfile + xml."""
    from .pdf_extract import PageText, PdfDocument, _parse_layout_tables

    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path, "r") as zf:
        if "word/document.xml" not in zf.namelist():
            return PdfDocument(path=path, metadata_doi=None, pages=[], backend="docx")
        root = ET.fromstring(zf.read("word/document.xml"))

    body = root.find("w:body", ns)
    paras: list[str] = []
    tables: list[list[list[str]]] = []
    if body is not None:
        for child in body:
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "p":
                txt = "".join(t.text or "" for t in child.findall(".//w:t", ns)).strip()
                if txt:
                    paras.append(txt)
            elif tag == "tbl":
                tb: list[list[str]] = []
                for tr in child.findall("w:tr", ns):
                    row = [
                        " ".join("".join(t.text or "" for t in p.findall(".//w:t", ns)).strip() for p in tc.findall("w:p", ns)).strip()
                        for tc in tr.findall("w:tc", ns)
                    ]
                    if any(row):
                        tb.append(row)
                if len(tb) >= 2:
                    tables.append(tb)

    text = "\n".join(paras)
    if not tables and text:
        tables = _parse_layout_tables(text)
    return PdfDocument(path=path, metadata_doi=None, pages=[PageText(page_num=1, text=text, layout_text=text, tables=tables)], backend="docx")


def _read_csv_as_document(path: Path) -> Any:
    from .pdf_extract import PageText, PdfDocument

    raw = path.read_text(encoding="utf-8", errors="replace")
    delim = "\t" if path.suffix.lower() == ".tsv" else ","
    rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(raw), delimiter=delim) if any(c.strip() for c in r)]
    tables = [rows] if len(rows) >= 2 else []
    return PdfDocument(path=path, metadata_doi=None, pages=[PageText(page_num=1, text="", layout_text="", tables=tables)], backend="csv")


def parse_si_file(
    si_path: Path,
    *,
    resolver: Resolver,
    doi: str | None,
    citation: str | None,
    default_role: str = "acceptor",
    default_cls: str | None = None,
    enable_ocr: bool = True,
) -> tuple[Any, list[Any]]:
    """Parse a single local SI file (.pdf, .md, .txt, .docx, .csv, .tsv) into (PdfDocument, candidates)."""
    from .pdf_extract import PageText, PdfDocument, extract_from_document, read_markdown
    from .pdf_markdown import pdf_to_markdown

    ext = si_path.suffix.lower()
    if ext == ".pdf":
        doc, _md, _pages = pdf_to_markdown(si_path, enable_ocr=enable_ocr)
    elif ext in (".md", ".markdown"):
        doc = read_markdown(si_path)
    elif ext == ".txt":
        raw = si_path.read_text(encoding="utf-8", errors="replace")
        from .pdf_extract import _parse_layout_tables

        doc = PdfDocument(
            path=si_path,
            metadata_doi=None,
            pages=[PageText(page_num=1, text=raw, layout_text=raw, tables=_parse_layout_tables(raw))],
            backend="text",
        )
    elif ext == ".docx":
        doc = _read_docx_as_document(si_path)
    elif ext in (".csv", ".tsv"):
        doc = _read_csv_as_document(si_path)
    else:
        return None, []

    cands = extract_from_document(
        doc,
        resolver=resolver,
        doi_override=doi,
        citation_override=citation,
        default_role=default_role,
        default_cls=default_cls,
        use_si=False,
    )
    for c in cands:
        c.location = f"SI ({si_path.name}), {c.location}"[:200]
        c.verify_note = "Extracted from Supporting Information without LLM; verify structure and values."
    return doc, cands


def _extract_si_section_defaults(si_docs: list[Any]) -> dict[str, dict[str, Any]]:
    """Extract global computational / experimental method and condition defaults from SI text."""
    from .pdf_extract import _BASIS_RE, _CALC_HINT_RE, _EXP_HINT_RE, _FUNC_RE, _SOLV_MODEL_RE, _extract_method_and_conditions

    defaults: dict[str, dict[str, Any]] = {}
    calc_blobs: list[str] = []
    exp_blobs: list[str] = []

    for doc in si_docs:
        for p in getattr(doc, "pages", []):
            txt = getattr(p, "text", "") or ""
            for para in re.split(r"\n\s*\n", txt):
                clean_p = re.sub(r"\s+", " ", para).strip()
                if len(clean_p) < 20:
                    continue
                if _CALC_HINT_RE.search(clean_p) and (_FUNC_RE.search(clean_p) or _BASIS_RE.search(clean_p) or _SOLV_MODEL_RE.search(clean_p)):
                    calc_blobs.append(clean_p)
                elif _EXP_HINT_RE.search(clean_p):
                    exp_blobs.append(clean_p)

    if calc_blobs:
        joined = " ".join(calc_blobs[:4])
        et_type, method, conditions, func, basis, solv = _extract_method_and_conditions(joined, "calc")
        defaults["calc"] = {
            "et_type": et_type,
            "method": method,
            "conditions": conditions,
            "func": func,
            "basis": basis,
            "solv": solv,
        }
    if exp_blobs:
        joined = " ".join(exp_blobs[:4])
        et_type, method, conditions, solvent, temp, _ = _extract_method_and_conditions(joined, "exp")
        defaults["exp"] = {
            "et_type": et_type,
            "method": method,
            "conditions": conditions,
            "tech": None if method == "Not stated" else method,
            "solvent": solvent,
            "temp": temp,
        }
    return defaults


_ANON_PREFIX_RE = re.compile(
    r"^(?:compound|compd|entry|substrate|catalyst|sensitizer|donor|acceptor|complex|molecule|mol|cat|ps)\s+",
    re.IGNORECASE,
)


def _strip_anon_prefix(name: str) -> str:
    return normalize_name_key(_ANON_PREFIX_RE.sub("", (name or "").strip()))


def _extract_si_label_resolutions(si_docs: list[Any], resolver: Resolver) -> dict[str, tuple[str, str | None, str | None]]:
    """Map paper-local labels (e.g. '4a', 'compound 4a') found in SI headings/tables to (name, smiles, cas)."""
    out: dict[str, tuple[str, str | None, str | None]] = {}
    lbl_def_re = re.compile(
        r"^(?:compound|compd|substrate|sensitizer|donor|acceptor|complex|catalyst)?\s*"
        r"(\d+[a-z]{0,2}|[A-Z]\d+)\s*[:\-–=]\s*([^\n.;]{4,140})",
        re.IGNORECASE | re.MULTILINE,
    )

    def _register(lbl: str, desc: str, raw_smi: str | None = None, cas_hint: str | None = None) -> None:
        if not looks_like_anonymous_label(lbl):
            return
        res = resolver.resolve_molecule(desc, cas=cas_hint, raw_smiles=raw_smi)
        if res.smiles:
            clean_desc = desc if not looks_like_anonymous_label(desc) else lbl
            val = (clean_desc, res.smiles, res.cas)
            out[normalize_name_key(lbl)] = val
            out[_strip_anon_prefix(lbl)] = val
            out[normalize_name_key(f"compound {lbl}")] = val

    for doc in si_docs:
        for p in getattr(doc, "pages", []):
            for m in lbl_def_re.finditer(getattr(p, "text", "") or ""):
                _register(m.group(1).strip(), m.group(2).strip())

            for tb in getattr(p, "tables", []):
                if len(tb) < 2:
                    continue
                hdr = [c.lower() for c in tb[0]]
                lbl_col = next((i for i, h in enumerate(hdr) if any(k in h for k in ("entry", "label", "code", "id", "compound", "compd"))), None)
                name_col = next((i for i, h in enumerate(hdr) if i != lbl_col and any(k in h for k in ("name", "iupac", "structure", "molecule", "compound"))), None)
                smi_col = next((i for i, h in enumerate(hdr) if "smiles" in h), None)
                cas_col = next((i for i, h in enumerate(hdr) if "cas" in h), None)
                if lbl_col is None or (name_col is None and smi_col is None):
                    continue
                for row in tb[1:]:
                    if lbl_col >= len(row):
                        continue
                    lbl = row[lbl_col].strip()
                    desc = row[name_col].strip() if (name_col is not None and name_col < len(row)) else lbl
                    smi = row[smi_col].strip() if (smi_col is not None and smi_col < len(row)) else None
                    cas_h = row[cas_col].strip() if (cas_col is not None and cas_col < len(row)) else None
                    if lbl:
                        _register(lbl, desc or lbl, raw_smi=smi, cas_hint=cas_h)
    return out


def _matches_candidate(a: Any, b: Any) -> bool:
    if a.origin != b.origin:
        return False
    if abs(float(a.et_kcal) - float(b.et_kcal)) > 1.0:
        return False
    if a.smiles and b.smiles:
        can_a = chem.canonical_smiles(a.smiles, isomeric=True) if chem.HAS_RDKIT else a.smiles
        can_b = chem.canonical_smiles(b.smiles, isomeric=True) if chem.HAS_RDKIT else b.smiles
        if can_a and can_b and can_a == can_b:
            return True
    nk_a = normalize_name_key(a.name)
    nk_b = normalize_name_key(b.name)
    if nk_a and nk_a == nk_b:
        return True
    sk_a = _strip_anon_prefix(a.name)
    sk_b = _strip_anon_prefix(b.name)
    return bool(sk_a and sk_a == sk_b)


_UNSPECIFIED_ET_TYPES = ("Other or not stated", "Computed; vertical or adiabatic not specified", "Not stated")


def _fill_method_conditions(target: Any, src_map: dict[str, Any]) -> bool:
    """Fill missing et_type, method/tech, conditions, and origin-specific fields from a dict."""
    changed = False
    src_et = src_map.get("et_type")
    if (not target.et_type or target.et_type in _UNSPECIFIED_ET_TYPES) and src_et and src_et not in _UNSPECIFIED_ET_TYPES:
        target.et_type = src_et
        changed = True

    if target.origin == "calc":
        attrs = ("func", "basis", "solv")
        generic_methods = ("DFT", "TD-DFT", "Not stated")
        generic_cond = "Solvent model not stated"
    else:
        attrs = ("tech", "solvent", "temp")
        generic_methods = ("Not stated",)
        generic_cond = "Not stated"

    for attr in attrs:
        if not getattr(target, attr) and src_map.get(attr):
            setattr(target, attr, src_map[attr])
            changed = True
    src_method = src_map.get("method")
    if (not target.method or target.method in generic_methods) and src_method and src_method not in generic_methods:
        target.method = src_method
        changed = True
    src_cond = src_map.get("conditions")
    if (not target.conditions or target.conditions == generic_cond) and src_cond and src_cond != generic_cond:
        target.conditions = src_cond
        changed = True
    return changed


def _apply_entry_enrichment(target: Any, src: Any, si_label: str) -> bool:
    changed = False
    if not target.smiles and src.smiles:
        target.smiles = src.smiles
        target.resolution_source = src.resolution_source or "si_enrichment"
        target.structure_note = f"Structure resolved from Supporting Information ({si_label}); verify against paper."
        changed = True
    if looks_like_anonymous_label(target.name) and src.name and not looks_like_anonymous_label(src.name):
        target.name = src.name[:200]
        changed = True
    if not target.cas and src.cas:
        target.cas = src.cas
        changed = True
    if not target.cls and src.cls:
        target.cls = src.cls
        changed = True
    if target.et_unc is None and src.et_unc is not None:
        target.et_unc = src.et_unc
        changed = True

    if _fill_method_conditions(
        target,
        {
            "et_type": src.et_type,
            "func": src.func,
            "basis": src.basis,
            "solv": src.solv,
            "tech": src.tech,
            "solvent": src.solvent,
            "temp": src.temp,
            "method": src.method,
            "conditions": src.conditions,
        },
    ):
        changed = True

    if target.uv_lmax is None and src.uv_lmax is not None:
        target.uv_lmax = src.uv_lmax
        target.uv_eps = src.uv_eps
        target.uv_cond = target.uv_cond or src.uv_cond
        changed = True
    if not target.direct_exc and src.direct_exc:
        target.direct_exc = dict(src.direct_exc)
        changed = True

    if changed:
        note = f"Enriched from Supporting Information ({si_label})."
        if note not in target.verify_note:
            target.verify_note = f"{target.verify_note.rstrip()} {note}".strip()
    return changed


def _apply_section_defaults(target: Any, defaults: dict[str, dict[str, Any]]) -> bool:
    sec = defaults.get(target.origin)
    if not sec or not _fill_method_conditions(target, sec):
        return False
    note = "Missing method/conditions enriched from Supporting Information."
    if note not in target.verify_note:
        target.verify_note = f"{target.verify_note.rstrip()} {note}".strip()
    return True


def enrich_with_si(
    doc: Any,
    candidates: list[Any],
    *,
    resolver: Resolver,
    doi: str | None,
    citation: str | None,
    default_role: str = "acceptor",
    default_cls: str | None = None,
    enable_ocr: bool = True,
    fetch_si: bool = True,
    si_paths: Sequence[str | Path] | None = None,
    si_cache_dir: str | Path | None = ".cache/trendb_si",
) -> list[Any]:
    """Discover, download (when online), parse Supporting Information, and enrich/extend candidates."""
    explicit_files = [Path(p) for p in (si_paths or []) if Path(p).is_file()]
    companion_files = find_local_si_files(doc.path) if getattr(doc, "path", None) else []

    si_files: list[Path] = []
    seen_paths: set[Path] = set()
    for p in [*explicit_files, *companion_files]:
        rp = p.resolve()
        if rp not in seen_paths:
            seen_paths.add(rp)
            si_files.append(p)

    dl_warnings: list[str] = []
    _, linked_dois = has_si_references(doc)
    need_si = bool(si_files) or should_fetch_si(doc, candidates)

    if need_si and fetch_si and not resolver.offline and (doi or linked_dois):
        primary_doi = doi or linked_dois[0]
        dl = download_si_for_doi(
            primary_doi,
            resolver=resolver,
            extra_dois=linked_dois,
            cache_dir=si_cache_dir,
        )
        dl_warnings.extend(dl.warnings)
        for p in dl.files:
            rp = p.resolve()
            if rp not in seen_paths:
                seen_paths.add(rp)
                si_files.append(p)

    if not si_files:
        if dl_warnings and candidates:
            for c in candidates:
                c.warnings.extend(dl_warnings)
        return list(candidates)

    si_docs: list[Any] = []
    si_candidates: list[Any] = []
    for sp in si_files:
        s_doc, s_cands = parse_si_file(
            sp,
            resolver=resolver,
            doi=doi,
            citation=citation,
            default_role=default_role,
            default_cls=default_cls,
            enable_ocr=enable_ocr,
        )
        if s_doc is not None:
            si_docs.append(s_doc)
        si_candidates.extend(s_cands)

    defaults = _extract_si_section_defaults(si_docs)
    label_map = _extract_si_label_resolutions(si_docs, resolver)
    si_label = ", ".join(p.name for p in si_files[:3])

    merged: list[Any] = list(candidates)
    for c in merged:
        if not c.smiles and c.name:
            nk = normalize_name_key(c.name)
            sk = _strip_anon_prefix(c.name)
            hit_label = label_map.get(nk) or label_map.get(sk)
            if hit_label:
                desc, smi, cas = hit_label
                c.name = desc[:200]
                c.smiles = smi
                c.cas = c.cas or cas
                c.resolution_source = "si_label_definition"
                c.structure_note = f"Structure resolved from Supporting Information ({si_label}); verify against paper."

        for sc in si_candidates:
            if _matches_candidate(c, sc):
                _apply_entry_enrichment(c, sc, Path(sc.pdf_file).name or si_label)

        _apply_section_defaults(c, defaults)
        if dl_warnings:
            c.warnings.extend(dl_warnings)

    for sc in si_candidates:
        if not any(_matches_candidate(existing, sc) for existing in merged):
            _apply_section_defaults(sc, defaults)
            merged.append(sc)

    return merged
