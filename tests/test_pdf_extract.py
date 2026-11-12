"""End-to-end tests for deterministic PDF extraction, review staging, and batch creation."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from trendb.batch import build_batch, build_batch_from_review, validate_batch_rows
from trendb.cli import main_extract, main_scrape
from trendb.models import BATCH_ROW_KEYS
from trendb.pdf_extract import extract_markdown, extract_pdf
from trendb.resolvers import Resolver


def _build_minimal_pdf(pages_lines: list[list[tuple[int, int, str]]]) -> bytes:
    """Create a valid uncompressed PDF 1.4 with Helvetica text positioned at (x, y)."""
    objs: list[bytes] = []

    # 1: Catalog, 2: Pages, 3: Font
    page_ids = [4 + 2 * i for i in range(len(pages_lines))]
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objs.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    objs.append(f"2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>\nendobj\n".encode())
    objs.append(b"3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

    for i, lines in enumerate(pages_lines):
        pid = 4 + 2 * i
        cid = pid + 1
        stream_parts = ["BT", "/F1 10 Tf"]
        for x, y, txt in lines:
            esc = txt.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream_parts.append(f"1 0 0 1 {x} {y} Tm ({esc}) Tj")
        stream_parts.append("ET")
        stream = "\n".join(stream_parts).encode("latin-1", errors="replace")
        objs.append(
            f"{pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {cid} 0 R >>\nendobj\n".encode()
        )
        objs.append(
            f"{cid} 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode()
            + stream
            + b"\nendstream\nendobj\n"
        )

    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    )
    return bytes(out)


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="Poppler pdftotext required for PDF test")
def test_pdf_extract_table_and_prose_to_batch_and_review(tmp_path: Path) -> None:
    pdf_path = tmp_path / "paper_test.pdf"
    pages = [
        [
            (50, 740, "Triplet Energies of Photosensitizers and Alkenes"),
            (50, 720, "DOI: 10.1021/example.2026.001"),
            (50, 690, "Abstract"),
            (50, 670, "Styrene exhibits a 0-0 transition to the lowest triplet state at 2.69 eV in solid argon at 15 K."),
            (50, 630, "Table 1. Measured and computed triplet energies (phosphorescence in MeCN at 77 K)"),
            (50, 605, "Compound"),
            (180, 605, "ET (kcal/mol)"),
            (290, 605, "ET calc (kcal/mol)"),
            (420, 605, "Method"),
            (50, 585, "Benzophenone"),
            (180, 585, "68.5"),
            (290, 585, "69.2"),
            (420, 585, "B3LYP/6-31G* PCM"),
            (50, 565, "compound 4a"),
            (180, 565, "52.0"),
            (290, 565, "53.4"),
            (420, 565, "B3LYP/6-31G* PCM"),
        ]
    ]
    pdf_path.write_bytes(_build_minimal_pdf(pages))

    batches_dir = tmp_path / "batches"
    batches_dir.mkdir()
    (batches_dir / "index.json").write_text('{"files": []}\n', encoding="utf-8")
    out_dir = tmp_path / "extracted"

    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        cands = extract_pdf(pdf_path, resolver=resolver)
        # 1 from Abstract (Styrene) + 4 from Table 1 (Benzophenone exp/calc + compound 4a exp/calc)
        assert len(cands) == 5
        styrene = next(c for c in cands if c.name == "Styrene")
        assert styrene.location == "Abstract"
        assert styrene.verify_level == "abstract"
        bp_calc = next(c for c in cands if c.name == "Benzophenone" and c.origin == "calc")
        assert bp_calc.et_kcal == 69.2
        assert "B3LYP" in bp_calc.method

        # Dry-run first: must NOT modify batches_dir
        dry = build_batch(cands, resolver=resolver, batches_dir=batches_dir, write_batch=False, out_dir=out_dir)
        assert dry.batch_path == out_dir / "batch-preview.json"
        assert not (batches_dir / "batch-001.json").exists()

        res = build_batch(
            cands,
            resolver=resolver,
            batches_dir=batches_dir,
            write_batch=True,
            out_dir=out_dir,
        )

    assert len(res.ready_rows) == 3
    assert res.batch_path == batches_dir / "batch-001.json"
    assert res.batch_path.is_file()
    written = json.loads(res.batch_path.read_text(encoding="utf-8"))
    assert all(tuple(r.keys()) == BATCH_ROW_KEYS for r in written)
    assert validate_batch_rows(written) == []

    idx_data = json.loads((batches_dir / "index.json").read_text(encoding="utf-8"))
    assert idx_data["files"] == ["batch-001.json"]

    # Unresolved "compound 4a" rows must be routed to needs_review.json
    assert res.review_path is not None and res.review_path.is_file()
    review_items = json.loads(res.review_path.read_text(encoding="utf-8"))
    assert len(review_items) == 2
    assert all("4a" in item["name"] for item in review_items)

    # Simulate curator adding SMILES to needs_review.json and promoting to batch-002.json
    for item in review_items:
        item["smiles"] = "CC1(C)OB(/C=C/c2ccccc2)OC1(C)C"
    edited_review = tmp_path / "edited_review.json"
    edited_review.write_text(json.dumps(review_items, indent=2), encoding="utf-8")

    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        res2 = build_batch_from_review(
            edited_review,
            resolver=resolver,
            batches_dir=batches_dir,
            write_batch=True,
            out_dir=out_dir,
        )
    assert res2.batch_path == batches_dir / "batch-002.json"
    assert len(res2.review_items) == 0
    idx_data2 = json.loads((batches_dir / "index.json").read_text(encoding="utf-8"))
    assert idx_data2["files"] == ["batch-001.json", "batch-002.json"]


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="Poppler pdftotext required for PDF test")
def test_cli_extract_and_scrape(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    pdf_path = tmp_path / "cli_sample.pdf"
    pages = [
        [
            (50, 740, "DOI: 10.1021/cli.test.2026"),
            (50, 700, "Thioxanthone has a measured triplet energy of 65.5 kcal/mol by phosphorescence at 77 K."),
        ]
    ]
    pdf_path.write_bytes(_build_minimal_pdf(pages))

    batches_dir = tmp_path / "batches"
    batches_dir.mkdir()
    (batches_dir / "index.json").write_text('{"files": []}\n', encoding="utf-8")
    out_dir = tmp_path / "stage"

    rc = main_extract(
        [
            "extract",
            str(pdf_path),
            "--batches-dir",
            str(batches_dir),
            "--out-dir",
            str(out_dir),
            "--offline",
            "--write-batch",
        ]
    )
    assert rc == 0
    assert (batches_dir / "batch-001.json").is_file()
    capsys.readouterr()

    rc2 = main_scrape(["--batches-dir", str(batches_dir), "--origin", "exp", "--format", "json"])
    assert rc2 == 0
    captured = capsys.readouterr().out
    scraped = json.loads(captured)
    assert len(scraped) == 1
    assert scraped[0]["name"].lower() == "thioxanthone"
    assert scraped[0]["et_kcal"] == 65.5


def test_markdown_and_classic_jacs_patterns(tmp_path: Path) -> None:
    md_path = tmp_path / "ja00973a001.md"
    md_text = """# Mechanisms of Photochemical Reactions in Solution. XXXIX.

<!-- page 1 -->

Mechanisms of Photochemical Reactions in Solution. XXXIX.
Downloaded from pubs.acs.org/jacsat/article-pdf/88/21/4769/6554755/ja00973a001.pdf by reader

---

<!-- page 6 -->

The behavior of the compound with sensitizers having excitation energies between 42 and 58 kcal/mole is definitely nonclassical.
cis-Stilbene has a vertical excitation energy of 57 kcal/mole.

---

<!-- page 7 -->

The triplet energy of benzil was taken as 50.9 kcal/mole rather than 53.7 kcal/mole.

---

<!-- page 8 -->

Table VII. Phosphorescence in Rigid and Fluid Solvents

| Substance | E_T,a | Solvent | Temp | Ref |
| --- | --- | --- | --- | --- |
| | kcal/mole | | | |
| 2,2'-Binaphthyl | 55.9 | EPA | 77 °K | c |
| Benzil | 50.9 | Benzene | 20 °C | h, i |

Table VIII. Triplet Excitation Energies of Sensitizers

| Sensitizer | E_T,a kcal/mole | Solvent | Ref |
| --- | --- | --- | --- |
| Triphenylene | 66.6 | MCIP | 32 |
| 3,4-Benzpyrene | 41.9h | Ethanol | 38i |

Triplet energy assignments are based on the position of the 0-0 band in phosphorescence spectra at 77 °K.

The triplet energy of duroquinone was estimated from singlet-triplet absorption spectra in n-heptane and have 0-0 bands at 51.6 kcal/mole.
Acridine was assigned a triplet energy of 45.3 kcal/mole on the basis of its singlet-triplet absorption spectrum taken with chloroform solvent in the presence of a high oxygen pressure.
Assignment of triplet energy values of these sensitizers is based upon Figures 1-5, where it appears that triplet energies of 47.0 kcal/mole for benzanthrone and 45.5 kcal/mole for 3-acetylpyrene are in harmony with the different plots.
That these triplet energies are reasonably accurate is demonstrated by the fact that 3-bromobenzanthrone and pyrene have phosphorescence 0-0 bands (77°K) at 45.7 and 48.2 kcal/mole, respectively.
"""
    md_path.write_text(md_text, encoding="utf-8")

    batches_dir = tmp_path / "batches"
    batches_dir.mkdir()
    (batches_dir / "index.json").write_text('{"files": ["batch-001.json"]}\n', encoding="utf-8")
    # Seed batch-001 with an IUPAC name for triphenylene to verify local IUPAC upgrade
    (batches_dir / "batch-001.json").write_text(
        json.dumps([{"import_key": "existing:1", "name": "triphenylene", "smiles": "c1ccc2c(c1)c1ccccc1c1ccccc21", "et_kcal": 66.0, "origin": "calc"}]),
        encoding="utf-8",
    )
    out_dir = tmp_path / "stage_md"

    with Resolver(cache_path=None, batches_dir=batches_dir, offline=True) as resolver:
        cands = extract_markdown(md_path, resolver=resolver)
        by_name = {(c.name.lower(), c.et_kcal): c for c in cands}

        # ACS DOI recovered cleanly (and no URL leaked into fields)
        assert all(c.doi == "10.1021/ja00973a001" for c in cands)
        # Range "between 42 and 58" and rejected "rather than 53.7" must not be extracted
        assert not any(c.et_kcal in (42.0, 58.0, 53.7) for c in cands)
        # Multi-row header + Roman numeral caption + Temp/Ref/footnote extracted
        binap = by_name[("2,2'-binaphthyl", 55.9)]
        assert "Table VII" in binap.location
        assert binap.conditions == "EPA, 77 K"
        assert binap.et_type == "Spectroscopic, 0-0 band"
        assert "Cited ref in table: c" in binap.verify_note

        # Table VIII (second table on page 8) + footnote-suffixed number 41.9h
        bp = by_name[("3,4-benzpyrene", 41.9)]
        assert "Table VIII" in bp.location
        assert bp.smiles is not None

        # Multi-molecule prose sentence paired accurately
        assert ("benzanthrone", 47.0) in by_name
        assert ("3-acetylpyrene", 45.5) in by_name
        assert ("duroquinone", 51.6) in by_name
        assert ("acridine", 45.3) in by_name
        assert ("cis-stilbene", 57.0) in by_name
        assert by_name[("cis-stilbene", 57.0)].origin == "exp"
        assert ("3-bromobenzanthrone", 45.7) in by_name
        assert ("pyrene", 48.2) in by_name
        assert by_name[("acridine", 45.3)].method == "S0→T1 absorption (O2 or heavy-atom perturbed)"

    rc = main_extract(
        [
            "extract",
            str(md_path),
            "--batches-dir",
            str(batches_dir),
            "--out-dir",
            str(out_dir),
            "--offline",
            "--write-batch",
        ]
    )
    assert rc == 0
    batch2 = batches_dir / "batch-002.json"
    assert batch2.is_file()
    rows = json.loads(batch2.read_text(encoding="utf-8"))
    assert len(rows) >= 8
    assert validate_batch_rows(rows) == []
    assert json.loads((batches_dir / "index.json").read_text(encoding="utf-8"))["files"] == ["batch-001.json", "batch-002.json"]


def test_preview_json_appends_by_default_and_overwrite_flag(tmp_path: Path) -> None:
    p1 = tmp_path / "p1.md"
    p1.write_text("DOI: 10.1021/p1.2026\n\nThioxanthone has a triplet energy of 65.5 kcal/mol.\n", encoding="utf-8")
    p2 = tmp_path / "p2.md"
    p2.write_text("DOI: 10.1021/p2.2026\n\nBenzophenone has a triplet energy of 68.5 kcal/mol.\n", encoding="utf-8")

    batches_dir = tmp_path / "batches"
    batches_dir.mkdir()
    (batches_dir / "index.json").write_text('{"files": []}\n', encoding="utf-8")
    out_dir = tmp_path / "stage"

    assert main_extract(["extract", str(p1), "--batches-dir", str(batches_dir), "--out-dir", str(out_dir), "--offline"]) == 0
    preview = out_dir / "batch-preview.json"
    assert len(json.loads(preview.read_text(encoding="utf-8"))) == 1

    # Second extract appends p2 to batch-preview.json without overwriting p1
    assert main_extract(["extract", str(p2), "--batches-dir", str(batches_dir), "--out-dir", str(out_dir), "--offline"]) == 0
    rows = json.loads(preview.read_text(encoding="utf-8"))
    assert len(rows) == 2
    assert {r["doi"] for r in rows} == {"10.1021/p1.2026", "10.1021/p2.2026"}
    assert validate_batch_rows(rows) == []

    # Re-running p2 does not duplicate existing preview entries
    assert main_extract(["extract", str(p2), "--batches-dir", str(batches_dir), "--out-dir", str(out_dir), "--offline"]) == 0
    assert len(json.loads(preview.read_text(encoding="utf-8"))) == 2

    # --overwrite replaces batch-preview.json with only the current run
    assert main_extract(["extract", str(p2), "--batches-dir", str(batches_dir), "--out-dir", str(out_dir), "--offline", "--overwrite"]) == 0
    rows_ow = json.loads(preview.read_text(encoding="utf-8"))
    assert len(rows_ow) == 1
    assert rows_ow[0]["doi"] == "10.1021/p2.2026"


