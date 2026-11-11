"""Figure extraction and OCSR integration using DECIMER-Image_Transformer."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import chem
from .pdf_markdown import ocr_image_tesseract, render_pdf_page_png

try:  # pragma: no cover - optional heavyweight ML dependency
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[assignment]

_LABEL_RE = re.compile(r"\b(\d+[a-z]{0,2}|C\d+|[A-Z]{1,3}\d+|[A-Za-z0-9\-]+TX)\b")


@dataclass
class ExtractedFigure:
    page_num: int
    image_path: Path
    label: str | None = None
    predicted_smiles: str | None = None
    source: str = ""


def decimer_available() -> bool:
    try:
        import DECIMER  # noqa: F401

        return True
    except ImportError:
        return False


def decimer_segmentation_available() -> bool:
    try:
        import decimer_segmentation  # noqa: F401

        return True
    except ImportError:
        return False


def predict_smiles_decimer(image_path: str | Path) -> str | None:
    """Run Kohulan/DECIMER-Image_Transformer on an image and validate with RDKit."""
    try:
        from DECIMER import predict_SMILES
    except ImportError as exc:
        raise ImportError(
            "DECIMER is not installed. Install `decimer` (from Kohulan/DECIMER-Image_Transformer) to run OCSR."
        ) from exc

    raw = predict_SMILES(str(image_path))
    if not raw or not isinstance(raw, str):
        return None
    raw = raw.strip()
    if chem.HAS_RDKIT:
        return chem.canonical_smiles(raw, isomeric=True)
    return raw


def detect_figure_label(image_path: str | Path) -> str | None:
    """Try to read a compact compound label (e.g. '4a', 'C1', '3-MeOTX') inside a figure crop."""
    if not shutil.which("tesseract"):
        return None
    try:
        txt = ocr_image_tesseract(image_path, psm=6)
    except Exception:
        return None
    for m in _LABEL_RE.finditer(txt):
        tok = m.group(1)
        if any(ch.isdigit() for ch in tok):
            return tok
    return None


def _is_usable_figure(path: Path, min_size: int) -> bool:
    if Image is None:
        return path.stat().st_size > 512
    try:
        with Image.open(path) as im:
            w, h = im.size
            if w < min_size or h < min_size:
                return False
            extrema = im.convert("L").getextrema()
            if extrema[0] == extrema[1]:
                return False
            return True
    except Exception:
        return False


def extract_figures_from_pdf(
    pdf_path: str | Path,
    out_dir: str | Path,
    *,
    pages: set[int] | None = None,
    min_size: int = 48,
    use_segmentation: bool = True,
) -> list[ExtractedFigure]:
    """Extract chemical structure crops (via decimer_segmentation) or embedded PNGs (pdfimages)."""
    pdf = Path(pdf_path)
    fig_dir = Path(out_dir)
    fig_dir.mkdir(parents=True, exist_ok=True)
    results: list[ExtractedFigure] = []

    # 1. Preferred: DECIMER Segmentation on rendered page images (handles vector ChemDraw figures!)
    if use_segmentation and decimer_segmentation_available():  # pragma: no cover - requires decimer_segmentation
        from decimer_segmentation import segment_chemical_structures
        import cv2

        target_pages = sorted(pages) if pages else [1]
        for pno in target_pages:
            page_png = render_pdf_page_png(pdf, pno, fig_dir, dpi=300)
            img = cv2.imread(str(page_png))
            if img is None:
                continue
            segments = segment_chemical_structures(img)
            for idx, seg in enumerate(segments, start=1):
                crop_path = fig_dir / f"{pdf.stem}_p{pno}_seg_{idx}.png"
                cv2.imwrite(str(crop_path), seg)
                if _is_usable_figure(crop_path, min_size):
                    results.append(ExtractedFigure(page_num=pno, image_path=crop_path, source="decimer_segmentation"))
                else:
                    crop_path.unlink(missing_ok=True)
            page_png.unlink(missing_ok=True)
        if results:
            return results

    # 2. Fallback: Poppler `pdfimages -png -p` extracts embedded raster figures tagged by page number
    pdfimages = shutil.which("pdfimages")
    if pdfimages:
        prefix = fig_dir / f"{pdf.stem}_img"
        subprocess.run(
            [pdfimages, "-png", "-p", str(pdf), str(prefix)],
            capture_output=True,
            text=True,
            check=False,
        )
        for img_path in sorted(fig_dir.glob(f"{prefix.name}-*.png")):
            m = re.search(r"-(\d+)-(\d+)\.png$", img_path.name)
            pno = int(m.group(1)) if m else 1
            if pages is not None and pno not in pages:
                img_path.unlink(missing_ok=True)
                continue
            if not _is_usable_figure(img_path, min_size):
                img_path.unlink(missing_ok=True)
                continue
            results.append(ExtractedFigure(page_num=pno, image_path=img_path, source="pdfimages"))
    return results


def run_ocsr_on_pdf(
    pdf_path: str | Path,
    out_dir: str | Path,
    *,
    pages: set[int] | None = None,
    predictor: Callable[[str | Path], str | None] | None = None,
) -> list[ExtractedFigure]:
    """Extract figures from a PDF and run DECIMER-Image_Transformer SMILES prediction."""
    figs = extract_figures_from_pdf(pdf_path, out_dir, pages=pages)
    pred_fn = predictor or (predict_smiles_decimer if decimer_available() else None)
    for fig in figs:
        fig.label = detect_figure_label(fig.image_path)
        if pred_fn is not None:
            try:
                raw_smi = pred_fn(fig.image_path)
                if raw_smi:
                    can = chem.canonical_smiles(raw_smi, isomeric=True) if chem.HAS_RDKIT else raw_smi
                    if can:
                        fig.predicted_smiles = can
                        fig.source = "decimer_image_transformer"
            except Exception:
                continue
    return figs
