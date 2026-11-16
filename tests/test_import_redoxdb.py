"""RedoxDB -> redox_entries conversion on a small synthetic clone."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from trendb import scoring
from trendb.models import REDOX_BATCH_ROW_KEYS
from trendb.redoxdb import convert, main

MOLECULES = [
    {"import_key": "lit:pho:rubpy3", "name": "[Ru(bpy)3](PF6)2", "iupac_name": None, "smiles": "c1ccc(-c2ccccn2)nc1",
     "cas": None, "category": "photocatalyst", "class": "Ru(II) polypyridyl", "functional_groups": [],
     "excited_state": "MLCT (T1)", "tau_ns": 1100, "lambda_abs_nm": 452, "solvent": "MeCN", "electrolyte": None},
    {"import_key": "lit:sub:toluene", "name": "toluene", "iupac_name": "methylbenzene", "smiles": "Cc1ccccc1",
     "cas": "108-88-3", "category": "substrate", "class": "arene", "functional_groups": ["benzylic C-H"],
     "excited_state": None, "tau_ns": None, "lambda_abs_nm": None, "solvent": "MeCN"},
    {"import_key": "lit:pho:mixed", "name": "Mixed PC", "smiles": "c1ccccc1", "category": "photocatalyst",
     "excited_state": "mixed", "functional_groups": []},
    {"import_key": "lit:pho:nosmiles", "name": "No structure", "smiles": None, "category": "photocatalyst", "functional_groups": []},
]
DOI = "10.1021/cr300503r"
ROTH = "10.1055/s-0035-1561297"
MEASUREMENTS = [
    {"molecule_key": "lit:pho:rubpy3", "quantity": "e_red", "value": -1.33, "value_type": "E1/2", "kind": "experimental",
     "method": "CV, E1/2", "solvent": "MeCN", "ref_original": "SCE", "conversion": None, "doi": DOI, "confidence": "high",
     "source": "Prier 2013", "import_key": "lit:pho:rubpy3|e_red|-1.33"},
    {"molecule_key": "lit:pho:rubpy3", "quantity": "e00", "value": 2.1, "value_type": "E0,0", "kind": "experimental",
     "method": "spectroscopy", "doi": "10.1016/0010-8545(88)80032-8", "confidence": "high", "import_key": "lit:pho:rubpy3|e00|2.1"},
    {"molecule_key": "lit:pho:rubpy3", "quantity": "e_star_ox", "value": -0.81, "value_type": "reported", "kind": "experimental",
     "method": "excited-state potential as reported", "solvent": "MeCN", "ref_original": "SCE", "doi": DOI, "confidence": "high",
     "source": "Prier 2013", "import_key": "lit:pho:rubpy3|e_star_ox|-0.81"},
    {"molecule_key": "lit:pho:rubpy3", "quantity": "e_ox", "value": 1.04, "value_type": "E1/2", "kind": "experimental",
     "method": "CV, E1/2", "solvent": "H2O", "ref_original": "NHE", "conversion": "E(SCE) = E(NHE) - 0.241 (from 1.28 V vs NHE)",
     "doi": DOI, "confidence": "high", "source": "Prier 2013", "import_key": "lit:pho:rubpy3|e_ox|1.04"},
    {"molecule_key": "lit:sub:toluene", "quantity": "e_ox", "value": 2.36, "value_type": "Ep/2", "kind": "experimental",
     "method": "CV, E_p/2", "solvent": "MeCN", "ref_original": "Ag/AgCl (3.5 M NaCl)", "conversion": "E(SCE) = E(Ag/AgCl) - 0.03 V",
     "doi": ROTH, "confidence": "medium", "source": "Roth 2016", "import_key": "lit:sub:toluene|e_ox|2.36"},
    {"molecule_key": "lit:sub:toluene", "quantity": "e_ox", "value": 2.12, "value_type": "calc", "kind": "computational",
     "method": "DFT B3LYP/6-31+G(d,p), CPCM(MeCN)", "solvent": "MeCN", "ref_original": None, "doi": ROTH, "confidence": "high",
     "source": "Roth 2016", "import_key": "lit:sub:toluene|e_ox|2.12|calc"},
    {"molecule_key": "lit:sub:toluene", "quantity": "e_red", "value": -3.0, "value_type": "E1/2", "kind": "experimental",
     "method": "CV", "doi": None, "confidence": "low", "notes": "recalled, not re-verified", "source": "RedoxDB first literature compilation",
     "import_key": "lit:sub:toluene|e_red|-3.0"},
    {"molecule_key": "lit:pho:mixed", "quantity": "e_star_red", "value": 1.5, "value_type": "reported", "kind": "experimental",
     "doi": DOI, "confidence": "medium", "import_key": "lit:pho:mixed|e_star_red|1.5"},
    {"molecule_key": "lit:pho:nosmiles", "quantity": "e_red", "value": -1.0, "value_type": "E1/2", "kind": "experimental",
     "doi": DOI, "confidence": "medium", "import_key": "lit:pho:nosmiles|e_red|-1.0"},
]


@pytest.fixture()
def clone(tmp_path: Path) -> Path:
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "molecules.json").write_text(json.dumps(MOLECULES), encoding="utf-8")
    (tmp_path / "data" / "measurements.json").write_text(json.dumps(MEASUREMENTS), encoding="utf-8")
    return tmp_path


def test_rows_and_review(clone: Path) -> None:
    res = convert(clone)
    by_key = {r["import_key"]: r for r in res["rows"]}
    assert set(by_key) == {
        "redoxdb:lit:pho:rubpy3|e_red|-1.33",
        "redoxdb:lit:pho:rubpy3|e_star_ox|-0.81",
        "redoxdb:lit:pho:rubpy3|e_ox|1.04",
        "redoxdb:lit:sub:toluene|e_ox|2.36",
        "redoxdb:lit:sub:toluene|e_ox|2.12|calc",
    }
    reasons = sorted(r["reason"] for r in res["review"])
    assert reasons == ["excited state not assigned (mixed)", "no DOI (TrEnDB cites sources by DOI)", "no SMILES"]
    assert res["counts"]["skipped_e00"] == 1
    for r in res["rows"]:
        assert set(r) <= set(REDOX_BATCH_ROW_KEYS)
        assert r["e_v"] is not None and r["e_ref"] in scoring.REDOX_REFS


def test_excited_state_and_e00(clone: Path) -> None:
    star = next(r for r in convert(clone)["rows"] if r["state"] != "S0")
    assert star["kind"] == "ox" and star["state"] == "T1"
    assert star["excited_from"] == "estimated" and star["e00_ev"] == 2.1
    assert star["e00_note"].startswith("E0,0 from doi:10.1016/")
    assert star["tau_ns"] == 1100 and star["uv_lmax"] == 452
    assert star["structure_note"] == "Excited state: MLCT (T1)"
    assert star["verify_level"] == "primaria"


def test_value_back_against_its_own_reference(clone: Path) -> None:
    rows = {r["import_key"]: r for r in convert(clone)["rows"]}
    tol = rows["redoxdb:lit:sub:toluene|e_ox|2.36"]
    assert tol["e_ref"] == "Ag/AgCl (3.5 M NaCl)" and tol["e_v"] == 2.39 and tol["e_sce"] == 2.36
    assert "RedoxDB: E(SCE) = E(Ag/AgCl) - 0.03 V" in tol["e_reported"]
    assert tol["name"] == "methylbenzene" and tol["commercial_name"] == "toluene"
    assert tol["category"] == "substrate" and tol["activated_group"] == "benzylic C-H"
    assert tol["verify_level"] == "secondaria"
    calc = rows["redoxdb:lit:sub:toluene|e_ox|2.12|calc"]
    assert calc["origin"] == "calc" and calc["e_ref"] == "SCE" and calc["e_sce"] == 2.12
    assert calc["method"].startswith("Computation, DFT B3LYP")


def test_nhe_values_stay_against_sce(clone: Path) -> None:
    row = {r["import_key"]: r for r in convert(clone)["rows"]}["redoxdb:lit:pho:rubpy3|e_ox|1.04"]
    assert row["e_ref"] == "SCE" and row["e_v"] == 1.04 and row["e_sce"] == 1.04
    assert "RedoxDB: E(SCE) = E(NHE) - 0.241 (from 1.28 V vs NHE)" in row["e_reported"]


def test_rows_pass_the_redox_rules(clone: Path) -> None:
    for r in convert(clone)["rows"]:
        payload = {"name": r["name"], "smiles": r["smiles"], "kind": r["kind"], "state": r["state"], "e": r["e_v"], "ref": r["e_ref"],
                   "origin": r["origin"], "doi": r["doi"], "excited_from": r.get("excited_from"), "e00": r.get("e00_ev")}
        assert scoring.required_redox_error(scoring.normalize_redox(payload), {"structureOk": True}) is None
        assert 0 < r["score"] <= 100


def test_cli_writes_batch_and_review(clone: Path, tmp_path: Path) -> None:
    out, rev = tmp_path / "batch.json", tmp_path / "review.json"
    assert main([str(clone), "-o", str(out), "--review", str(rev)]) == 0
    assert len(json.loads(out.read_text())) == 5 and len(json.loads(rev.read_text())) == 3
