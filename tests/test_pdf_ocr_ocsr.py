"""Tests for field conciseness cleanup, Tesseract OCR -> Markdown, and DECIMER OCSR integration."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from trendb.clean_fields import (
    audit_conciseness,
    clean_direct_exc,
    clean_uv,
    normalize_row_fields,
    parse_direct_exc,
    parse_uv_fields,
)
from trendb.cli import main_extract
from trendb.ocsr import extract_figures_from_pdf
from trendb.pdf_extract import extract_pdf
from trendb.pdf_markdown import pdf_to_markdown
from trendb.resolvers import Resolver

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_batch_001_conciseness_clean() -> None:
    rows = json.loads((REPO_ROOT / "docs" / "batches" / "batch-001.json").read_text(encoding="utf-8"))
    assert audit_conciseness(rows) == []

    assert parse_uv_fields("Absorption maximum 321 nm; ε at 427 nm = 61 M⁻¹ cm⁻¹ (THF, 10⁻⁴ M)") == (
        321,
        61,
        "THF, 10⁻⁴ M; ε at 427 nm",
    )
    assert parse_uv_fields("Lowest-energy absorption maximum 328 nm (ε = 20,000 M⁻¹ cm⁻¹); ε at 415 nm = 260 M⁻¹ cm⁻¹ (CH3CN)") == (
        328,
        20000,
        "MeCN; ε(415 nm) 260 M⁻¹ cm⁻¹",
    )
    assert parse_direct_exc("The paper excites the complex with a 415 nm LED.") == {"LED": 415}
    assert parse_direct_exc({"LED": 415, "Kessil": "427"}) == {"LED": 415, "Kessil": 427}

    sample = normalize_row_fields(
        {
            "uv": "Longest-wavelength absorption maximum 354 nm (MeCN, 1 × 10⁻⁴ M)",
            "direct_exc": "The paper irradiates these catalysts at 427 nm.",
            "verify_note": "Read in PDF.",
        }
    )
    assert sample["uv_lmax"] == 354
    assert sample["uv_eps"] is None
    assert sample["uv_cond"] == "MeCN, 10⁻⁴ M"
    assert sample["direct_exc"] == {"irradiation": 427}


@pytest.mark.skipif(
    shutil.which("tesseract") is None or shutil.which("pdftoppm") is None,
    reason="Tesseract and Poppler pdftoppm required for scanned PDF OCR test",
)
def test_scanned_image_pdf_ocr_to_markdown_and_extract(tmp_path: Path) -> None:
    # Render a real image-only PDF (no digital text layer)
    img = Image.new("RGB", (1400, 420), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 36)
    except Exception:
        font = ImageFont.load_default()
    draw.text((40, 60), "DOI: 10.1021/ocr.test.2026", fill="black", font=font)
    draw.text((40, 150), "Thioxanthone shows a triplet energy of 65.5 kcal/mol", fill="black", font=font)
    draw.text((40, 220), "measured by phosphorescence in MeCN at 77 K.", fill="black", font=font)

    scanned_pdf = tmp_path / "scanned.pdf"
    img.save(scanned_pdf, "PDF", resolution=150.0)
    md_path = tmp_path / "scanned.md"

    doc, md_text, pages = pdf_to_markdown(scanned_pdf, enable_ocr=True, save_path=md_path)
    assert pages[0].used_ocr is True
    assert md_path.is_file()
    assert "65.5" in md_text
    assert "Thioxanthone" in md_text

    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        cands = extract_pdf(scanned_pdf, resolver=resolver, enable_ocr=True, save_markdown_dir=tmp_path / "md")
    assert len(cands) >= 1
    tx = next(c for c in cands if c.name.lower() == "thioxanthone")
    assert tx.et_kcal == 65.5
    assert tx.smiles == "O=c1c2ccccc2sc2ccccc12"
    assert (tmp_path / "md" / "scanned.md").is_file()


@pytest.mark.skipif(
    shutil.which("pdfimages") is None or shutil.which("pdftotext") is None,
    reason="Poppler pdfimages/pdftotext required for figure extraction test",
)
def test_decimer_ocsr_integration_on_embedded_figure_pdf(tmp_path: Path) -> None:
    # Build an image-embedded PDF (same mechanism as scanned figure PDF) and pair it with digital text page
    img = Image.new("RGB", (900, 260), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 30)
    except Exception:
        font = ImageFont.load_default()
    draw.text((40, 40), "compound 4a", fill="black", font=font)
    draw.line([(200, 140), (320, 140), (380, 190)], fill="black", width=4)

    fig_pdf = tmp_path / "fig_only.pdf"
    img.save(fig_pdf, "PDF", resolution=150.0)

    figs = extract_figures_from_pdf(fig_pdf, tmp_path / "figs", use_segmentation=False)
    assert len(figs) == 1
    assert figs[0].image_path.is_file()

    # Verify CLI `to-md` runs cleanly on the PDF
    rc = main_extract(["to-md", str(fig_pdf), "--out-dir", str(tmp_path / "md_cli")])
    assert rc == 0
    assert (tmp_path / "md_cli" / "fig_only.md").is_file()

    # Verify extract_pdf uses an injected DECIMER predictor to resolve compound 4a from the figure
    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        # Run on a digital-text PDF with an embedded figure or inject text via OCR on the image PDF
        img2 = Image.new("RGB", (1400, 320), "white")
        d2 = ImageDraw.Draw(img2)
        d2.text((40, 40), "DOI: 10.1021/decimer.test.2026", fill="black", font=font)
        d2.text((40, 110), "compound 4a has a triplet energy of 52.0 kcal/mol by DFT B3LYP/6-31G*.", fill="black", font=font)
        pdf2 = tmp_path / "with_fig.pdf"
        img2.save(pdf2, "PDF", resolution=150.0)

        cands = extract_pdf(
            pdf2,
            resolver=resolver,
            enable_ocr=True,
            figures_dir=tmp_path / "figs2",
            ocsr_predictor=lambda _path: "CC1(C)OB(/C=C/c2ccccc2)OC1(C)C",
        )
    assert len(cands) >= 1
    c4a = next(c for c in cands if "4a" in c.name)
    assert c4a.smiles == "CC1(C)OB(/C=C/c2ccccc2)OC1(C)C"
    assert c4a.resolution_source == "decimer_image_transformer"
