"""Simple PDF-to-Markdown converter with automatic Tesseract OCR for scanned pages."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .pdf_extract import PageText, PdfDocument, _parse_layout_tables, read_pdf

try:  # pragma: no cover - optional runtime dependency
    import fitz  # type: ignore
except ImportError:  # pragma: no cover
    fitz = None


@dataclass
class MarkdownPage:
    page_num: int
    text: str
    used_ocr: bool
    tables: list[list[list[str]]]
    markdown: str


def ocr_image_tesseract(image_path: str | Path, *, lang: str = "eng", psm: int = 6) -> str:
    """Run Tesseract CLI OCR on an image file and return plain text."""
    tesseract = shutil.which("tesseract")
    if not tesseract:
        raise RuntimeError("Tesseract binary not found on PATH. Install via `brew install tesseract`.")
    proc = subprocess.run(
        [tesseract, str(image_path), "stdout", "-l", lang, "--psm", str(psm)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Tesseract failed ({proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout.strip()


def render_pdf_page_png(pdf_path: str | Path, page_num: int, out_dir: str | Path, *, dpi: int = 300) -> Path:
    """Render a 1-indexed PDF page to PNG using PyMuPDF or Poppler pdftoppm."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{Path(pdf_path).stem}_page_{page_num}.png"

    if fitz is not None:  # pragma: no cover
        doc = fitz.open(str(pdf_path))
        try:
            page = doc[page_num - 1]
            pix = page.get_pixmap(dpi=dpi)
            pix.save(str(target))
            return target
        finally:
            doc.close()

    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        raise RuntimeError("Neither PyMuPDF nor Poppler `pdftoppm` is available to render PDF pages.")
    prefix = out / f"{Path(pdf_path).stem}_p{page_num}"
    subprocess.run(
        [pdftoppm, "-png", "-r", str(dpi), "-f", str(page_num), "-l", str(page_num), str(pdf_path), str(prefix)],
        capture_output=True,
        text=True,
        check=True,
    )
    candidates = sorted(out.glob(f"{prefix.name}*.png"))
    if not candidates:
        raise RuntimeError(f"pdftoppm produced no PNG for page {page_num} of {pdf_path}")
    candidates[0].rename(target)
    return target


def format_markdown_table(rows: list[list[str]]) -> str:
    """Render a 2D list of cells as a GitHub-flavored Markdown table."""
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm_rows = [
        [c.replace("|", "\\|").replace("\n", " ").strip() for c in r] + [""] * (width - len(r))
        for r in rows
    ]
    header = "| " + " | ".join(norm_rows[0]) + " |"
    sep = "| " + " | ".join("---" for _ in range(width)) + " |"
    body = ["| " + " | ".join(r) + " |" for r in norm_rows[1:]]
    return "\n".join([header, sep, *body])


def _page_text_to_markdown(page: PageText) -> str:
    lines: list[str] = [f"<!-- page {page.page_num} -->", ""]
    text = re.sub(r"\n{3,}", "\n\n", (page.text or "").strip())
    if text:
        lines.append(text)
    if page.tables:
        for i, tb in enumerate(page.tables, start=1):
            lines.extend(["", f"#### Table (p. {page.page_num}.{i})", "", format_markdown_table(tb)])
    return "\n".join(lines).strip()


def pdf_to_markdown(
    pdf_path: str | Path,
    *,
    enable_ocr: bool = True,
    ocr_lang: str = "eng",
    min_digital_chars: int = 80,
    save_path: str | Path | None = None,
) -> tuple[PdfDocument, str, list[MarkdownPage]]:
    """Convert a PDF into clean Markdown, applying Tesseract OCR on image-only/scanned pages."""
    doc = read_pdf(pdf_path)
    md_pages: list[MarkdownPage] = []
    updated_pages: list[PageText] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        for p in doc.pages:
            used_ocr = False
            text = p.text
            layout_text = p.layout_text
            tables = p.tables

            if enable_ocr and len(re.sub(r"\s+", "", text)) < min_digital_chars:
                if shutil.which("tesseract") and (fitz is not None or shutil.which("pdftoppm")):
                    png = render_pdf_page_png(doc.path, p.page_num, tmpdir)
                    ocr_txt = ocr_image_tesseract(png, lang=ocr_lang, psm=6)
                    if len(re.sub(r"\s+", "", ocr_txt)) > len(re.sub(r"\s+", "", text)):
                        text = ocr_txt
                        layout_text = ocr_txt
                        tables = _parse_layout_tables(ocr_txt)
                        used_ocr = True

            new_p = PageText(page_num=p.page_num, text=text, layout_text=layout_text, tables=tables)
            updated_pages.append(new_p)
            md_str = _page_text_to_markdown(new_p)
            md_pages.append(
                MarkdownPage(
                    page_num=p.page_num,
                    text=text,
                    used_ocr=used_ocr,
                    tables=tables,
                    markdown=md_str,
                )
            )

    doc = PdfDocument(path=doc.path, metadata_doi=doc.metadata_doi, pages=updated_pages, backend=doc.backend)
    full_md = f"# {doc.path.stem}\n\n" + "\n\n---\n\n".join(mp.markdown for mp in md_pages) + "\n"

    if save_path is not None:
        sp = Path(save_path)
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(full_md, encoding="utf-8")

    return doc, full_md, md_pages
