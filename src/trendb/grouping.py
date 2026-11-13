"""Pair each paper with its Supporting Information files, by file name first and by content otherwise."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from . import scoring
from .textnorm import normalize_text

try:  # pragma: no cover - optional runtime dependency
    import fitz  # type: ignore
except ImportError:  # pragma: no cover
    fitz = None

MAIN_EXTS = {".pdf"}
SI_EXTS = {".pdf", ".md", ".markdown", ".txt", ".docx", ".csv", ".tsv", ".zip"}

# "<paper>_si", "<paper>-SI_001", "<paper> supporting information", "<paper>.suppl2" ...
_SI_SUFFIX_RE = re.compile(
    r"^(?P<base>.+?)[\s_.\-]+(?:si|esi|supp|suppl|supporting|supplementary|supplemental)"
    r"(?:[\s_.\-]*(?:info|information|material|materials|data))?(?:[\s_.\-]*\d{1,3})?$",
    re.IGNORECASE,
)
_SI_TITLE_RE = re.compile(
    r"^\W{0,3}(?:electronic\s+)?(?:support(?:ing|ive)|supplementa(?:ry|l))\s+(?:information|material|materials|data)\b",
    re.IGNORECASE,
)
_SI_PAGE_LABEL_RE = re.compile(r"^\s*(?:page\s+)?S[-\s]?\d{1,3}\s*$", re.IGNORECASE | re.MULTILINE)
_ARTICLE_MARK_RE = re.compile(r"^\s*(?:abstract|introduction)\b", re.IGNORECASE | re.MULTILINE)
_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>\]\[),;]+")


@dataclass
class PaperGroup:
    main: Path
    si: list[Path] = field(default_factory=list)
    main_is_si: bool = False  # an SI file with no paper to attach to, processed on its own
    how: str = ""  # how the SI files were matched, for the report


def si_base_stem(stem: str) -> str | None:
    """Return the paper stem an SI file name points to, or None when the name is not an SI name."""
    m = _SI_SUFFIX_RE.match(stem.strip())
    return m.group("base").strip().lower() if m else None


def companion_si_files(main_path: Path) -> list[Path]:
    """SI files sitting next to a paper and named after it (paper_si.pdf, paper-SI_001.docx, ...)."""
    if not main_path.parent.is_dir():
        return []
    stem_low = main_path.stem.lower()
    out: list[Path] = []
    for p in sorted(main_path.parent.iterdir()):
        if not p.is_file() or p.suffix.lower() not in SI_EXTS or p.resolve() == main_path.resolve():
            continue
        if si_base_stem(p.stem) == stem_low:
            out.append(p)
    return out


def peek_pdf_text(path: Path, pages: int = 2) -> list[str]:
    """Text of the first pages of a PDF; an unreadable file yields an empty list."""
    try:
        if fitz is not None:  # pragma: no cover - used when pymupdf is installed
            doc = fitz.open(str(path))
            try:
                return [normalize_text(doc[i].get_text("text") or "") for i in range(min(pages, len(doc)))]
            finally:
                doc.close()
        pdftotext = shutil.which("pdftotext")
        if not pdftotext:
            return []
        proc = subprocess.run(
            [pdftotext, "-l", str(pages), str(path), "-"], capture_output=True, text=True, check=False
        )
        if proc.returncode != 0:
            return []
        return [normalize_text(t) for t in proc.stdout.split("\f") if t.strip()][:pages]
    except Exception:
        return []


def looks_like_si(page_texts: list[str]) -> bool:
    """Judge from the opening pages whether a document is Supporting Information.

    Papers also print "Supporting Information" on their first page, so the phrase only counts when it
    opens one of the first lines and the page has no Abstract/Introduction heading. Pages labelled
    S1, S2, ... are decisive on their own.
    """
    if not page_texts:
        return False
    if any(_SI_PAGE_LABEL_RE.search(t) for t in page_texts):
        return True
    first = page_texts[0]
    head_lines = [ln.strip() for ln in first.splitlines() if ln.strip()][:12]
    titled = any(_SI_TITLE_RE.match(ln) for ln in head_lines)
    return titled and not _ARTICLE_MARK_RE.search(first)


def _dois_in(texts: Iterable[str]) -> set[str]:
    out: set[str] = set()
    for t in texts:
        for m in _DOI_RE.finditer(t):
            d = scoring.clean_doi(m.group(0))
            if scoring.is_doi(d):
                out.add(d.lower())
    return out


def _main_doi(path: Path, texts: list[str]) -> str | None:
    """DOI of a paper from its first page (before the reference list) or from its file name."""
    if texts:
        head = re.split(r"\b(?:References|Bibliography)\b", texts[0], maxsplit=1)[0]
        for m in _DOI_RE.finditer(head):
            d = scoring.clean_doi(m.group(0))
            if scoring.is_doi(d):
                return d.lower()
    m_fn = _DOI_RE.search(path.stem.replace("_", "/"))
    if m_fn:
        d = scoring.clean_doi(m_fn.group(0))
        if scoring.is_doi(d):
            return d.lower()
    return None


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _title_lines(texts: list[str]) -> list[str]:
    """Long lines from the top of the first page, squashed; the title is among them."""
    if not texts:
        return []
    lines = [ln.strip() for ln in texts[0].splitlines() if ln.strip()][:15]
    return [sq for sq in (_squash(ln) for ln in lines if len(ln) >= 30) if len(sq) >= 25]


def group_inputs(paths: Iterable[Path]) -> tuple[list[PaperGroup], list[Path]]:
    """Split files into papers and their SI; returns (groups, unmatched non-PDF SI files).

    Groups follow the input order of the papers. Matching, in order: file name; the paper's DOI printed
    in the SI; the paper's title printed on the SI cover page; a folder holding exactly one paper. An SI
    PDF that matches nothing is returned as its own group with ``main_is_si`` set.
    """
    files: list[Path] = []
    seen: set[Path] = set()
    for p in paths:
        rp = p.resolve()
        if rp not in seen and p.is_file():
            seen.add(rp)
            files.append(p)

    stems = {p.stem.lower() for p in files if p.suffix.lower() in MAIN_EXTS}
    peeks: dict[Path, list[str]] = {}
    mains: list[Path] = []
    si_files: list[Path] = []
    for p in files:
        base = si_base_stem(p.stem)
        if p.suffix.lower() not in MAIN_EXTS:
            si_files.append(p)
            continue
        if base is not None and base in stems:
            si_files.append(p)
            continue
        peeks[p] = peek_pdf_text(p)
        if base is not None or looks_like_si(peeks[p]):
            si_files.append(p)
        else:
            mains.append(p)

    groups = {m: PaperGroup(main=m) for m in mains}
    by_stem = {m.stem.lower(): m for m in mains}
    main_doi = {m: _main_doi(m, peeks.get(m, [])) for m in mains}
    title_lines = {m: _title_lines(peeks.get(m, [])) for m in mains}
    # A line shared by several papers is a journal banner, not a title.
    line_owners: dict[str, int] = {}
    for lines in title_lines.values():
        for ln in set(lines):
            line_owners[ln] = line_owners.get(ln, 0) + 1

    def attach(main: Path, si: Path, how: str) -> None:
        g = groups[main]
        g.si.append(si)
        if how not in g.how:
            g.how = f"{g.how}, {how}".strip(", ")

    orphans: list[Path] = []
    for s in si_files:
        base = si_base_stem(s.stem)
        if base is not None and base in by_stem:
            attach(by_stem[base], s, "file name")
            continue
        texts = peeks.get(s)
        if texts is None:
            texts = peek_pdf_text(s) if s.suffix.lower() == ".pdf" else []
        if texts:
            dois = _dois_in(texts)
            doi_hits = [m for m in mains if main_doi[m] and main_doi[m] in dois]
            if len(doi_hits) == 1:
                attach(doi_hits[0], s, "DOI printed in the SI")
                continue
            squashed = _squash(texts[0])
            title_hits = [
                m for m in mains if any(line_owners[ln] == 1 and ln in squashed for ln in title_lines[m])
            ]
            if len(title_hits) == 1:
                attach(title_hits[0], s, "paper title on the SI cover page")
                continue
        same_dir = [m for m in mains if m.parent.resolve() == s.parent.resolve()]
        if len(same_dir) == 1:
            attach(same_dir[0], s, "only paper in the folder")
            continue
        orphans.append(s)

    out = [groups[m] for m in mains]
    unmatched: list[Path] = []
    for s in orphans:
        if s.suffix.lower() in MAIN_EXTS:
            out.append(PaperGroup(main=s, main_is_si=True, how="no matching paper"))
        else:
            unmatched.append(s)
    return out, unmatched
