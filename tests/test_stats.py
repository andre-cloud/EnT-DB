"""Tests for TrEnDB statistical summaries, exp-vs-calc benchmarking, spread, and RDKit descriptors."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from trendb import TrEnDBClient
from trendb.cli import main_stats
from trendb.models import Entry
from trendb.stats import analyze_entries, compare_exp_calc, compute_descriptors, et_histogram, molecule_spread

REPO_ROOT = Path(__file__).resolve().parents[1]


def _sample_entries() -> list[Entry]:
    return [
        Entry(
            id="1",
            name="Thioxanthone",
            cas="492-22-8",
            smiles="O=c1c2ccccc2sc2ccccc12",
            cls="Thioxanthones",
            role="donor",
            origin="exp",
            et_kcal=65.5,
            doi="10.1021/jacs.0c05069",
            score=89,
            uv_lmax=380,
            uv_cond="MeCN",
            direct_exc={"LED": 415},
        ),
        Entry(
            id="2",
            name="Thioxanthone",
            cas="492-22-8",
            smiles="O=c1c2ccccc2sc2ccccc12",
            cls="Thioxanthones",
            role="donor",
            origin="exp",
            et_kcal=63.3,
            doi="10.1039/c8cs00054a",
            score=82,
        ),
        Entry(
            id="3",
            name="Thioxanthone",
            cas="492-22-8",
            smiles="O=c1c2ccccc2sc2ccccc12",
            cls="Thioxanthones",
            role="donor",
            origin="calc",
            et_kcal=66.4,
            doi="10.1021/jacs.3c07678",
            score=85,
        ),
        Entry(
            id="4",
            name="Styrene",
            cas="100-42-5",
            smiles="C=Cc1ccccc1",
            cls="Aryl alkenes",
            role="acceptor",
            origin="exp",
            et_kcal=62.0,
            doi="10.1063/1.466936",
            score=91,
        ),
        Entry(
            id="5",
            name="Styrene",
            cas="100-42-5",
            smiles="C=Cc1ccccc1",
            cls="Aryl alkenes",
            role="acceptor",
            origin="calc",
            et_kcal=63.0,
            doi="10.1021/example",
            score=76,
        ),
    ]


def test_analyze_entries_and_exp_vs_calc() -> None:
    entries = _sample_entries()
    st = analyze_entries(entries)
    assert st.total_entries == 5
    assert st.unique_molecules == 2
    assert st.unique_dois == 5
    assert st.by_origin == {"exp": 3, "calc": 2}
    assert st.score_grades == {"Good": 4, "Fair": 1}
    assert st.completeness["cas"]["count"] == 5
    assert st.completeness["uv_lmax"]["count"] == 1
    assert st.completeness["direct_exc"]["count"] == 1
    assert st.et_overall is not None and st.et_overall.min == 62.0 and st.et_overall.max == 66.4

    # Exp vs Calc: TX exp_mean=(65.5+63.3)/2=64.4, calc=66.4 -> diff=+2.0; Styrene exp=62.0, calc=63.0 -> diff=+1.0
    ec = compare_exp_calc(entries)
    assert ec.n_molecules == 2
    assert ec.mae == 1.5
    assert ec.bias == 1.5
    assert ec.max_abs_error == 2.0
    assert ec.pearson_r == 1.0

    # Spread: Thioxanthone exp has 2 entries (63.3 - 65.5 -> span 2.2)
    sp = molecule_spread(entries, origin="exp")
    assert len(sp) == 1
    assert sp[0].name == "Thioxanthone"
    assert sp[0].et_span == 2.2

    hist = et_histogram(entries, bins=4)
    assert sum(b["count"] for b in hist) == 5

    md = st.to_markdown()
    assert "TrEnDB Statistical Summary" in md
    assert "Experimental vs Computed" in md


def test_descriptors_and_real_batch_stats(tmp_path: Path, capsys) -> None:
    entries = _sample_entries()
    descs = compute_descriptors(entries)
    assert len(descs) == 5
    assert descs[0]["aromatic_rings"] == 3  # Thioxanthone

    client = TrEnDBClient.from_batches(REPO_ROOT / "docs" / "batches")
    st = client.stats()
    assert st.total_entries >= 187
    assert st.unique_molecules > 0
    assert "exp" in st.et_by_origin and "calc" in st.et_by_origin

    desc_csv = tmp_path / "desc.csv"
    out_json = tmp_path / "stats.json"
    rc = main_stats(
        [
            "--batches-dir",
            str(REPO_ROOT / "docs" / "batches"),
            "--format",
            "json",
            "-o",
            str(out_json),
            "--descriptors-csv",
            str(desc_csv),
        ]
    )
    assert rc == 0
    loaded = json.loads(out_json.read_text(encoding="utf-8"))
    assert loaded["total_entries"] == st.total_entries
    with desc_csv.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == st.total_entries
