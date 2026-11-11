"""Tests for DOI-based Supporting Information discovery, download, parsing, and enrichment."""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

import httpx
import pytest

from trendb.batch import build_batch, validate_batch_rows
from trendb.pdf_extract import extract_markdown, extract_pdf
from trendb.resolvers import Resolver
from trendb.si import download_si_for_doi, parse_si_file


def _build_minimal_pdf(pages_lines: list[list[tuple[int, int, str]]]) -> bytes:
    objs: list[bytes] = []
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
        objs.append(f"{cid} 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream\nendobj\n")
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode())
    return bytes(out)


def _build_minimal_docx(paragraphs: list[str], table_rows: list[list[str]] | None = None) -> bytes:
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    p_xml = "".join(f'<w:p><w:r><w:t>{p}</w:t></w:r></w:p>' for p in paragraphs)
    t_xml = ""
    if table_rows:
        trs = []
        for row in table_rows:
            tcs = "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row)
            trs.append(f"<w:tr>{tcs}</w:tr>")
        t_xml = f"<w:tbl>{''.join(trs)}</w:tbl>"
    doc_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{ns}"><w:body>{p_xml}{t_xml}</w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", doc_xml)
    return buf.getvalue()


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="Poppler pdftotext required for SI PDF test")
def test_doi_si_download_parse_and_enrich_from_html_link(tmp_path: Path) -> None:
    main_md = tmp_path / "main_paper.md"
    main_md.write_text(
        """# Main Paper

<!-- page 1 -->

DOI: 10.1021/si.test.2026

Details of the DFT calculations and characterization are provided in the Supporting Information (Table S1).

compound 4a has a computed triplet energy of 52.0 kcal/mol.
""",
        encoding="utf-8",
    )

    si_pdf_bytes = _build_minimal_pdf(
        [
            [
                (50, 740, "Supporting Information"),
                (50, 710, "Computational Details"),
                (50, 690, "All geometries were computed at the adiabatic TD-DFT level using wB97X-D/def2-TZVP with SMD in MeCN."),
                (50, 650, "Table S1. Compound legend and triplet energies"),
                (50, 625, "Entry"),
                (140, 625, "SMILES"),
                (380, 625, "ET (kcal/mol)"),
                (50, 605, "4a"),
                (140, 605, "CC1(C)OB(/C=C/c2ccccc2)OC1(C)C"),
                (380, 605, "52.0"),
                (50, 585, "Thioxanthone"),
                (140, 585, "O=c1c2ccccc2sc2ccccc12"),
                (380, 585, "65.5"),
            ]
        ]
    )

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(url)
        if "api.crossref.org/works/10.1021%2Fsi.test.2026" in url:
            return httpx.Response(
                200,
                json={
                    "message": {
                        "author": [{"family": "Doe"}],
                        "short-container-title": ["J. Am. Chem. Soc."],
                        "published-print": {"date-parts": [[2026]]},
                        "volume": "148",
                        "page": "100-110",
                        "URL": "https://publisher.example/article/si.test.2026",
                    }
                },
            )
        if "doi.org/api/handles/10.1021%2Fsi.test.2026" in url:
            return httpx.Response(200, json={"responseCode": 1})
        if url == "https://publisher.example/article/si.test.2026":
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text='<html><body><a href="/suppl/si_001.pdf">Supporting Information (PDF)</a></body></html>',
            )
        if url == "https://publisher.example/suppl/si_001.pdf":
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=si_pdf_bytes)
        if "pubchem.ncbi.nlm.nih.gov" in url or "opsin.ch.cam.ac.uk" in url:
            return httpx.Response(404)
        return httpx.Response(404)

    si_cache = tmp_path / "si_cache"
    batches_dir = tmp_path / "batches"
    batches_dir.mkdir()
    (batches_dir / "index.json").write_text('{"files": []}\n', encoding="utf-8")

    with Resolver(
        cache_path=":memory:",
        batches_dir=None,
        pubchem_interval=0.0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ) as resolver:
        cands = extract_markdown(main_md, resolver=resolver, fetch_si=True, si_cache_dir=si_cache)
        assert len(cands) == 2

        c4a = next(c for c in cands if c.et_kcal == 52.0)
        assert c4a.smiles == "CC1(C)OB(/C=C/c2ccccc2)OC1(C)C"
        assert c4a.func == "wB97X-D"
        assert c4a.basis == "def2-TZVP"
        assert "SMD" in (c4a.solv or "")
        assert "Supporting Information" in c4a.verify_note
        assert "http" not in c4a.verify_note.lower()

        tx = next(c for c in cands if c.name == "Thioxanthone")
        assert tx.et_kcal == 65.5
        assert tx.location.startswith("SI (si_001.pdf)")

        res = build_batch(cands, resolver=resolver, batches_dir=batches_dir, write_batch=True, out_dir=tmp_path / "out")
        assert len(res.ready_rows) == 2
        assert validate_batch_rows(res.ready_rows) == []

        # Second run reuses disk SI cache (no extra SI PDF fetch)
        before = len([u for u in calls if "si_001.pdf" in u])
        _ = extract_markdown(main_md, resolver=resolver, fetch_si=True, si_cache_dir=si_cache)
        after = len([u for u in calls if "si_001.pdf" in u])
        assert before == after == 1


def test_zenodo_zip_with_docx_and_csv_si_and_captcha_block(tmp_path: Path) -> None:
    docx_bytes = _build_minimal_docx(
        ["Supporting Information"],
        [
            ["Compound", "ET (kcal/mol)", "Method", "Conditions"],
            ["Benzophenone", "68.5", "Phosphorescence", "MCH glass, 77 K"],
        ],
    )
    csv_bytes = b"Compound,ET calc (kcal/mol),Method\nAnthracene,43.1,B3LYP/6-31G*\n"

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zf:
        zf.writestr("si_tables.docx", docx_bytes)
        zf.writestr("calc_data.csv", csv_bytes)
        zf.writestr("../../evil.txt", b"should be skipped by ZipSlip guard")
    zip_bytes = zip_buf.getvalue()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "zenodo.org/api/records/777777" in url:
            return httpx.Response(
                200,
                json={"files": [{"key": "bundle.zip", "links": {"self": "https://zenodo.org/records/777777/files/bundle.zip"}}]},
            )
        if url == "https://zenodo.org/records/777777/files/bundle.zip":
            return httpx.Response(200, headers={"content-type": "application/zip"}, content=zip_bytes)
        if "publisher.gated.example" in url or "doi.org/10.1021%2Fgated" in url or "doi.org/10.1021/gated" in url:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<html>cf-browser-verification verify you are human</html>")
        return httpx.Response(404)

    with Resolver(
        cache_path=":memory:",
        batches_dir=None,
        pubchem_interval=0.0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ) as resolver:
        dl = download_si_for_doi("10.5281/zenodo.777777", resolver=resolver, cache_dir=tmp_path / "cache_z")
        names = {p.name for p in dl.files}
        assert names == {"si_tables.docx", "calc_data.csv"}
        assert not (tmp_path / "evil.txt").exists()

        all_si_cands = []
        for f in dl.files:
            _, cands = parse_si_file(f, resolver=resolver, doi="10.5281/zenodo.777777", citation="Zenodo SI")
            all_si_cands.extend(cands)
        assert {(c.name, c.et_kcal, c.origin) for c in all_si_cands} == {
            ("Benzophenone", 68.5, "exp"),
            ("Anthracene", 43.1, "calc"),
        }

        # Gated / CAPTCHA page stops cleanly without bypassing
        gated = download_si_for_doi("10.1021/gated.2026", resolver=resolver, cache_dir=tmp_path / "cache_g")
        assert gated.files == []
        assert any("anti-bot" in w or "gated" in w for w in gated.warnings)


def test_companion_local_si_enriches_offline(tmp_path: Path) -> None:
    main_md = tmp_path / "study.md"
    main_md.write_text(
        "DOI: 10.1021/local.si.2026\n\ncompound 1a has a triplet energy of 65.5 kcal/mol.\n",
        encoding="utf-8",
    )
    si_md = tmp_path / "study_si.md"
    si_md.write_text(
        "1a: Thioxanthone\n\nPhosphorescence spectra were measured in MeCN at 77 K.\n",
        encoding="utf-8",
    )

    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        cands = extract_markdown(main_md, resolver=resolver)
    assert len(cands) == 1
    assert cands[0].smiles == "O=c1c2ccccc2sc2ccccc12"
    assert cands[0].tech == "Phosphorescence"
    assert cands[0].solvent == "MeCN"
    assert cands[0].temp == "77 K"
