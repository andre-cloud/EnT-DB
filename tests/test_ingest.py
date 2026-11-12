"""Tests for the one-command ingest: paper/SI grouping, text normalisation, units, failure isolation."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
import pytest

from test_pdf_extract import _build_minimal_pdf
from trendb import cli
from trendb.batch import _different_conditions
from trendb.grouping import group_inputs, looks_like_si, si_base_stem
from trendb.pdf_extract import (
    PdfReadError,
    _clean_molecule_name,
    _detect_header_unit,
    _extract_energy_matches_in_sentence,
    _is_et_header,
    read_pdf,
)
from trendb.resolvers import Resolver
from trendb.textnorm import normalize_text

needs_poppler = pytest.mark.skipif(shutil.which("pdftotext") is None, reason="Poppler pdftotext required")


def _paper_pages(title: str, doi: str, name: str, et: str) -> list[list[tuple[int, int, str]]]:
    return [
        [
            (50, 740, title),
            (50, 720, f"DOI: {doi}"),
            (50, 690, "Abstract"),
            (50, 670, "We report triplet energies measured by phosphorescence in MeCN at 77 K."),
            (50, 630, "Table 1. Measured triplet energies (phosphorescence in MeCN at 77 K)"),
            (50, 605, "Compound"),
            (180, 605, "ET (kcal/mol)"),
            (50, 585, name),
            (180, 585, et),
        ]
    ]


def _si_pages(doi: str | None = None, title: str | None = None) -> list[list[tuple[int, int, str]]]:
    lines = [(50, 740, "Supporting Information")]
    if title:
        lines.append((50, 720, title))
    if doi:
        lines.append((50, 700, f"for the article with DOI {doi}"))
    lines.append((50, 660, "General methods. Phosphorescence spectra were recorded in MeCN at 77 K."))
    lines.append((300, 40, "S1"))
    return [lines]


# --- text normalisation and units -------------------------------------------------------------------


def test_normalize_text_folds_ligatures_and_superscripts() -> None:
    assert normalize_text("riboﬂavin is eﬃcient") == "riboflavin is efficient"
    assert normalize_text("69.2 kcal·mol⁻¹") == "69.2 kcal·mol-1"
    assert normalize_text("a  b") == "a  b"  # column spacing must survive for layout tables


@pytest.mark.parametrize(
    "sentence, expected_unit, expected_val",
    [
        ("The triplet energy of benzophenone is 69.2 kcal·mol⁻¹ in benzene.", "kcal", 69.2),
        ("The triplet energy of benzophenone is 289 kJ mol-1 in benzene.", "kj", 289.0),
        ("The triplet energy of benzophenone is 24,200 cm⁻¹ in benzene.", "cm", 24200.0),
        ("The triplet energy of benzophenone is 3.00 eV in benzene.", "ev", 3.0),
    ],
)
def test_prose_units(sentence: str, expected_unit: str, expected_val: float) -> None:
    matches = _extract_energy_matches_in_sentence(normalize_text(sentence))
    assert [(m[4], m[2]) for m in matches] == [(expected_unit, expected_val)]


def test_singlet_value_is_not_taken_as_triplet_energy() -> None:
    sent = "trans-Stilbene has a singlet energy of 358 kJ/mol, whereas its triplet energy is 206 kJ/mol."
    assert [m[2] for m in _extract_energy_matches_in_sentence(sent)] == [206.0]


def test_et_header_detection_is_not_fooled_by_substrings() -> None:
    triplet_ctx = "Table 1. Triplet energies of sensitizers"
    assert _is_et_header("ET (eV)", "")
    assert _is_et_header("Triplet energy", "")
    assert _is_et_header("kcal/mol", triplet_ctx)
    assert not _is_et_header("kcal/mol", "Table 2. Reaction free energies")
    assert not _is_et_header("Level of theory", triplet_ctx)
    assert not _is_et_header("de (%)", triplet_ctx)
    assert not _is_et_header("ES (kcal/mol)", triplet_ctx)
    assert not _is_et_header("E1/2 (V vs SCE)", triplet_ctx)
    assert _detect_header_unit("Level") is None
    assert _detect_header_unit("Rev.") is None
    assert _detect_header_unit("E (eV)") == "ev"


def test_citation_number_glued_to_known_name_is_dropped() -> None:
    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        assert _clean_molecule_name("benzophenone83", resolver) == "benzophenone"
        assert _clean_molecule_name("unknownthing83", resolver) == "unknownthing83"


def test_close_values_under_different_conditions_are_not_duplicates() -> None:
    assert _different_conditions("MeCN, 77 K", "toluene, 298 K")
    assert not _different_conditions("MeCN, 77 K", "Not stated")
    assert not _different_conditions("MeCN,  77 K", "mecn, 77 k")


# --- resolver cache ---------------------------------------------------------------------------------


def test_transient_http_error_is_not_cached_as_unresolved() -> None:
    status = {"code": 503}

    def handler(request: httpx.Request) -> httpx.Response:
        if status["code"] != 200:
            return httpx.Response(status["code"])
        return httpx.Response(200, json={"status": "SUCCESS", "smiles": "CCO"})

    with Resolver(
        cache_path=":memory:",
        batches_dir=None,
        pubchem_interval=0.0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ) as resolver:
        assert resolver.resolve_opsin("ethanol") is None
        status["code"] = 200
        assert resolver.resolve_opsin("ethanol") == "CCO"


# --- paper / SI grouping ----------------------------------------------------------------------------


def test_si_base_stem() -> None:
    assert si_base_stem("ja0c05069_si_001") == "ja0c05069"
    assert si_base_stem("Paper-SI") == "paper"
    assert si_base_stem("smith 2020 Supporting Information") == "smith 2020"
    assert si_base_stem("paper.suppl2") == "paper"
    assert si_base_stem("ja0c05069") is None
    assert si_base_stem("synthesis") is None


def test_looks_like_si() -> None:
    assert looks_like_si(["Supporting Information\nfor a great paper\n"])
    assert looks_like_si(["Some cover text\n\n   S1\n"])
    assert not looks_like_si(["A Great Paper\nAuthors\nSupporting Information\nABSTRACT: we show...\n"])
    assert not looks_like_si(["A Great Paper\nIntroduction\nSee the Supporting Information for details.\n"])
    assert not looks_like_si([])


@needs_poppler
def test_group_inputs_by_name_doi_and_title(tmp_path: Path) -> None:
    a = tmp_path / "ja0c05069.pdf"
    a_si = tmp_path / "ja0c05069_si_001.pdf"
    b = tmp_path / "Second paper.pdf"
    b_si = tmp_path / "downloaded file (3).pdf"
    c = tmp_path / "third.pdf"
    c_si = tmp_path / "mmc1.pdf"
    a.write_bytes(_build_minimal_pdf(_paper_pages("Paper A on triplet sensitizers", "10.1021/aaa.001", "Benzophenone", "68.5")))
    a_si.write_bytes(_build_minimal_pdf(_si_pages()))
    b.write_bytes(_build_minimal_pdf(_paper_pages("Paper B on triplet sensitizers", "10.1021/bbb.002", "Xanthone", "74.0")))
    b_si.write_bytes(_build_minimal_pdf(_si_pages(doi="10.1021/bbb.002")))
    c.write_bytes(
        _build_minimal_pdf(_paper_pages("Energy transfer catalysis with thioxanthone dyes", "10.1021/ccc.003", "Thioxanthone", "65.5"))
    )
    c_si.write_bytes(_build_minimal_pdf(_si_pages(title="Energy transfer catalysis with thioxanthone dyes")))

    groups, unmatched = group_inputs(sorted(tmp_path.glob("*.pdf")))
    assert unmatched == []
    by_main = {g.main.name: g for g in groups}
    assert set(by_main) == {a.name, b.name, c.name}
    assert [p.name for p in by_main[a.name].si] == [a_si.name]
    assert [p.name for p in by_main[b.name].si] == [b_si.name]
    assert "DOI" in by_main[b.name].how
    assert [p.name for p in by_main[c.name].si] == [c_si.name]
    assert "title" in by_main[c.name].how

    # The classic entry point must not treat the ACS-style SI as a paper either.
    assert a_si.name not in {p.name for p in cli._expand_inputs([str(tmp_path)])}


@needs_poppler
def test_orphan_si_is_its_own_group(tmp_path: Path) -> None:
    for name, doi in (("one.pdf", "10.1021/one.1"), ("two.pdf", "10.1021/two.2")):
        (tmp_path / name).write_bytes(_build_minimal_pdf(_paper_pages(f"Title of {name} about triplets", doi, "Xanthone", "74.0")))
    (tmp_path / "mystery.pdf").write_bytes(_build_minimal_pdf(_si_pages()))
    groups, _ = group_inputs(sorted(tmp_path.glob("*.pdf")))
    orphan = [g for g in groups if g.main_is_si]
    assert [g.main.name for g in orphan] == ["mystery.pdf"]


# --- unreadable files and the one-command ingest ----------------------------------------------------


@needs_poppler
def test_corrupt_pdf_raises_pdf_read_error(tmp_path: Path) -> None:
    bad = tmp_path / "broken.pdf"
    bad.write_bytes(b"this is not a pdf at all")
    with pytest.raises(PdfReadError):
        read_pdf(bad)


@needs_poppler
def test_trendb_folder_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    root = tmp_path / "repo"
    (root / "docs" / "assets").mkdir(parents=True)
    (root / "docs" / "assets" / "config.js").write_text("window.ENT_CONFIG = {};\n", encoding="utf-8")
    batches = root / "docs" / "batches"
    batches.mkdir()
    (batches / "index.json").write_text('{"files": []}\n', encoding="utf-8")
    monkeypatch.setattr(cli, "find_repo_root", lambda: root)

    inbox = tmp_path / "inbox"
    (inbox / "sub").mkdir(parents=True)
    (inbox / "good.PDF").write_bytes(
        _build_minimal_pdf(_paper_pages("Paper A on triplet sensitizers", "10.1021/aaa.001", "Benzophenone", "68.5"))
    )
    (inbox / "good_SI.pdf").write_bytes(_build_minimal_pdf(_si_pages()))
    (inbox / "sub" / "other.pdf").write_bytes(
        _build_minimal_pdf(_paper_pages("Paper B on triplet sensitizers", "10.1021/bbb.002", "Xanthone", "74.0"))
    )
    (inbox / "broken.pdf").write_bytes(b"this is not a pdf at all")

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)  # paths must not depend on the working directory

    assert cli.main_ingest([str(inbox), "--offline"]) == 0
    out = capsys.readouterr().out
    assert "Failed: 1" in out

    batch = batches / "batch-001.json"
    assert batch.is_file()
    rows = json.loads(batch.read_text(encoding="utf-8"))
    assert {round(r["et_kcal"], 1) for r in rows} == {68.5, 74.0}
    assert json.loads((batches / "index.json").read_text(encoding="utf-8"))["files"] == ["batch-001.json"]

    report = (root / "extracted" / "report.md").read_text(encoding="utf-8")
    assert "broken.pdf" in report
    assert "good_SI.pdf" in report and "file name" in report
    assert not list(elsewhere.iterdir())

    # Running again on the same folder adds nothing: every value is already in docs/batches.
    assert cli.main_ingest([str(inbox), "--offline"]) == 0
    assert not (batches / "batch-002.json").exists()
    assert "none written" in capsys.readouterr().out


def test_trendb_command_without_pdfs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "find_repo_root", lambda: tmp_path)
    assert cli.main_ingest([str(tmp_path)]) == 2
