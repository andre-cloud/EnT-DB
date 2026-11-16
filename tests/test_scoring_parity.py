"""1:1 parity tests between trendb.scoring and docs/assets/score.js (via Node)."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from trendb import scoring

REPO_ROOT = Path(__file__).resolve().parents[1]
SCORE_JS = REPO_ROOT / "docs" / "assets" / "score.js"

NODE_BRIDGE = r"""
const fs = require('fs');
eval(fs.readFileSync(process.argv[1], 'utf8'));
const S = globalThis.EntScore;
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const out = cases.map(c => {
  const f = S.normalize(c.payload);
  const err = S.requiredError(f, c.ctx);
  const sc = S.scoreEntry(f, c.ctx);
  return {
    commercial_name: f.commercial_name,
    doi: f.doi,
    cas: f.cas,
    kcal: Number.isNaN(f.kcal) ? null : f.kcal,
    err,
    total: sc.total,
    grade: sc.grade,
    items: sc.items,
  };
});
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required for JS parity check")
def test_score_js_parity() -> None:
    cases = [
        {
            "payload": {
                "name": "Styrene",
                "smiles": "C=Cc1ccccc1",
                "role": "acceptor",
                "et": "2.69",
                "unit": "ev",
                "unc": "0.02",
                "origin": "exp",
                "kind": "Spectroscopic, 0-0 band",
                "tech": "Electron-energy-loss spectroscopy",
                "solvent": "Solid argon",
                "temp": "15 K",
                "cite": "Example J. 2000, 1, 1",
                "doi": "https://doi.org/10.1234/example.5678",
                "loc": "Abstract",
                "quote": "0-0 transition at 2.69 eV",
                "uv_lmax": "248",
                "uv_eps": "15000",
                "uv_cond": "MeCN",
                "direct_src": "LED",
                "direct_nm": "415",
            },
            "ctx": {"structureOk": True, "doiResolves": True, "same": []},
        },
        {
            "payload": {
                "name": "Styrene",
                "smiles": "C=Cc1ccccc1",
                "et": "62.05",
                "unit": "kcal",
                "origin": "exp",
                "doi": "doi: 10.1234/example.5678.",
                "cite": "Example J. 2000",
                "cas": "100425",
            },
            "ctx": {
                "structureOk": True,
                "doiResolves": False,
                "same": [{"name": "a", "doi": "10.1234/EXAMPLE.5678", "et_kcal": 62.1}],
            },
        },
        {
            "payload": {
                "name": "(E)-Anethole",
                "smiles": "C/C=C/c1ccc(OC)cc1",
                "origin": "calc",
                "et": "243,1",
                "unit": "kj",
                "kind": "Computed, adiabatic",
                "func": "B3LYP",
                "basis": "6-31G*",
                "solv": "PCM, MeCN",
                "cite": "Korff 2022",
                "doi": "https://pubs.example.org/doi/pdf/10.3390/molecules27165342",
                "loc": "Section 2",
                "quote": "w " * 26,
            },
            "ctx": {"structureOk": True, "doiResolves": None, "same": [{"name": "x", "doi": "10.1/y", "et_kcal": 55.0, "origin": "calc"}]},
        },
        {
            "payload": {
                "name": "Bad",
                "smiles": "C=C",
                "et": "250",
                "unit": "kcal",
                "origin": "calc",
                "kind": "Relaxed triplet",
                "doi": "https://example.org/no-doi",
                "cas": "100-42-6",
                "uv_lmax": "50",
                "direct_exc": "bad value",
            },
            "ctx": {"structureOk": None, "doiResolves": None, "same": None},
        },
        {
            "payload": {
                "commercial_name": "Thioxanthone",
                "smiles": "O=c1c2ccccc2sc2ccccc12",
                "et": "65.5",
                "origin": "exp",
                "kind": "Phosphorescence",
                "doi": "10.1021/jacs.0c05069",
            },
            "ctx": {"structureOk": True, "doiResolves": None, "same": None},
        },
        {
            "payload": {},
            "ctx": {"structureOk": False, "doiResolves": None, "same": None},
        },
    ]

    proc = subprocess.run(
        ["node", "-e", NODE_BRIDGE, str(SCORE_JS)],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
    )
    js_results = json.loads(proc.stdout)

    for case, js_res in zip(cases, js_results):
        f = scoring.normalize(case["payload"])
        py_err = scoring.required_error(f, case["ctx"])
        py_sc = scoring.score_entry(f, case["ctx"])
        assert f["commercial_name"] == js_res["commercial_name"]
        assert f["doi"] == js_res["doi"]
        assert f["cas"] == js_res["cas"]
        if js_res["kcal"] is None:
            assert math.isnan(f["kcal"])
        else:
            assert f["kcal"] == pytest.approx(js_res["kcal"])
        if case["payload"].get("commercial_name") and not case["payload"].get("name"):
            assert py_err == "Enter the IUPAC name."
        assert py_err == js_res["err"]
        assert py_sc["total"] == js_res["total"]
        assert py_sc["grade"] == js_res["grade"]
        assert py_sc["items"] == js_res["items"]


def test_clean_cas_and_round1_js_behavior() -> None:
    assert scoring.clean_cas(" 100–42–5 ") == "100-42-5"
    assert scoring.cas_valid("100-42-5")
    assert not scoring.cas_valid("100-42-6")
    assert scoring.round1(62.05) == 62.1
    assert scoring.round2(0.1 / 4.184) == 0.02


REDOX_BRIDGE = r"""
const fs = require('fs');
eval(fs.readFileSync(process.argv[1], 'utf8'));
const R = globalThis.EntScore.redox;
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const nn = (x) => (Number.isNaN(x) ? null : x);
const out = cases.map(c => {
  const f = R.normalize(c.payload);
  const sc = R.scoreEntry(f, c.ctx);
  return { v: nn(f.v), sce: nn(f.sce), ref: f.ref, err: R.requiredError(f, c.ctx),
           total: sc.total, grade: sc.grade, items: sc.items, doc: R.toDoc(f, sc) };
});
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required for JS parity check")
def test_redox_score_js_parity() -> None:
    base = {
        "name": "9,10-Dicyanoanthracene",
        "smiles": "N#Cc1c2ccccc2c(C#N)c2ccccc12",
        "kind": "red",
        "couple": "M/M•−",
        "e": "-0.89",
        "unc": "0.01",
        "ref": "SCE",
        "e_type": "E1/2 (reversible)",
        "tech": "Cyclic voltammetry",
        "solvent": "MeCN",
        "electrolyte": "0.1 M TBAPF6",
        "temp": "25 °C",
        "cite": "Example J. 2020",
        "doi": "https://doi.org/10.1234/example.5678",
        "loc": "Table 1",
        "quote": "E1/2 = -0.89 V vs SCE",
    }
    peers = [
        {"name": "a", "doi": "x", "e_sce": -0.95, "origin": "exp", "kind": "red", "state": "S0"},
        {"name": "b", "doi": "10.1234/EXAMPLE.5678", "e_sce": -1.52, "origin": "exp", "kind": "red", "state": "S0"},
    ]
    ok = {"structureOk": True, "doiResolves": True, "same": []}
    cases = [
        {"payload": base, "ctx": ok},
        {"payload": {**base, "e": "-1920", "unit": "mv", "ref": "fc/fc+"}, "ctx": {**ok, "same": peers}},
        {"payload": {**base, "ref": "Fc+/Fc", "solvent": ""}, "ctx": {**ok, "same": peers}},
        {"payload": {**base, "ref": "NHE", "e": "-1.3"}, "ctx": {**ok, "same": peers}},
        {
            "payload": {**base, "state": "T1", "excited_from": "estimated", "e00": "2.89", "e": "2.0", "ref": "Ag/AgCl"},
            "ctx": {**ok, "doiResolves": None},
        },
        {"payload": {**base, "state": "S1", "excited_from": "estimated"}, "ctx": ok},
        {
            "payload": {
                **base,
                "origin": "calc",
                "e_type": "Computed, adiabatic",
                "func": "M06-2X",
                "basis": "def2-TZVP",
                "solv": "SMD, MeCN",
                "ref": "Fc+/Fc",
                "quote": "w " * 26,
            },
            "ctx": {"structureOk": None, "doiResolves": None, "same": None},
        },
        {"payload": {**base, "e": "7", "ref": "Ag/Ag+", "e_type": "Computed, vertical"}, "ctx": ok},
        {"payload": {**base, "ref": "Ag/AgCl", "e": "-1.1"}, "ctx": {**ok, "same": peers}},
        {"payload": {**base, "ref": "Ag/AgCl (3.5 M NaCl)", "e": "2.36"}, "ctx": ok},
        {"payload": {**base, "ref": "Ag/Ag+ (0.01 M AgNO3)", "solvent": "DMSO"}, "ctx": ok},
        {"payload": {**base, "ref": "ferrocene", "solvent": "DMSO", "e": "-2.1"}, "ctx": ok},
        {
            "payload": {**base, "category": "photocatalyst", "uv_lmax": "452", "tau_ns": "1100", "activated_group": "C(sp3)-Br"},
            "ctx": ok,
        },
        {"payload": {**base, "uv_lmax": "50"}, "ctx": ok},
        {"payload": {**base, "tau_ns": "-2"}, "ctx": ok},
        {"payload": {**base, "ref": "", "doi": "https://example.org/no-doi"}, "ctx": ok},
        {"payload": {}, "ctx": {"structureOk": False, "doiResolves": None, "same": None}},
    ]

    proc = subprocess.run(
        ["node", "-e", REDOX_BRIDGE, str(SCORE_JS)],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
    )
    js_results = json.loads(proc.stdout)

    def nn(x: float) -> float | None:
        return None if math.isnan(x) else x

    for case, js in zip(cases, js_results):
        f = scoring.normalize_redox(case["payload"])
        sc = scoring.score_redox(f, case["ctx"])
        assert nn(f["v"]) == pytest.approx(js["v"]) if js["v"] is not None else nn(f["v"]) is None
        assert nn(f["sce"]) == js["sce"]
        assert f["ref"] == js["ref"]
        assert scoring.required_redox_error(f, case["ctx"]) == js["err"]
        assert sc["total"] == js["total"]
        assert sc["grade"] == js["grade"]
        assert sc["items"] == js["items"]
        if not math.isnan(f["v"]):
            assert scoring.to_redox_doc(f, sc) == js["doc"]


CLEAN_REF_INPUTS = [
    "vs. Fc/Fc+", "ferrocene", "SCE", "sce", "NHE", "Ag/AgCl (sat. KCl)", "Ag/AgCl, saturated KCl",
    "Ag/AgCl (3 M KCl)", "Ag/AgCl (3.0 M KCl)", "Ag/AgCl (1 M KCl)", "Ag/AgCl (3.5 M NaCl)", "Ag/AgCl",
    "Ag/Ag+ (0.01 M AgNO3)", "Ag/Ag+ (0.1 M AgNO3, MeCN)", "Ag/Ag+", "decamethylferrocene", "Hg/HgO", "",
]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required for JS parity check")
def test_redox_reference_table_parity() -> None:
    bridge = r"""
const fs = require('fs');
eval(fs.readFileSync(process.argv[1], 'utf8'));
const R = globalThis.EntScore.redox;
const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
const nn = (x) => (Number.isNaN(x) ? null : x);
const solvents = ["", "MeCN", "acetonitrile", "DMF", "CH2Cl2", "THF", "DMSO", "MeCN/CH2Cl2"];
process.stdout.write(JSON.stringify({
  refs: R.REFS,
  clean: inputs.map(R.cleanRef),
  sce: R.REFS.map(r => solvents.map(s => nn(R.toSce(-1.234, r, s)))),
  back: R.REFS.map(r => solvents.map(s => nn(R.fromSce(-1.234, r, s)))),
}));
"""
    proc = subprocess.run(
        ["node", "-e", bridge, str(SCORE_JS)], input=json.dumps(CLEAN_REF_INPUTS), capture_output=True, text=True, check=True
    )
    js = json.loads(proc.stdout)
    solvents = ["", "MeCN", "acetonitrile", "DMF", "CH2Cl2", "THF", "DMSO", "MeCN/CH2Cl2"]

    def nn(x: float) -> float | None:
        return None if math.isnan(x) else x

    assert list(scoring.REDOX_REFS) == js["refs"]
    assert [scoring.clean_ref(x) for x in CLEAN_REF_INPUTS] == js["clean"]
    assert [[nn(scoring.to_sce(-1.234, r, s)) for s in solvents] for r in scoring.REDOX_REFS] == js["sce"]
    assert [[nn(scoring.from_sce(-1.234, r, s)) for s in solvents] for r in scoring.REDOX_REFS] == js["back"]


def test_redox_reference_conversion() -> None:
    assert scoring.to_sce(-1.0, "SHE") == -1.241
    assert scoring.to_sce(-1.0, "Fc+/Fc", "acetonitrile") == -0.62
    assert scoring.to_sce(-1.0, "Ag/AgCl (3.5 M NaCl)") == -1.03
    assert math.isnan(scoring.to_sce(-1.0, "Fc+/Fc", "MeCN/CH2Cl2"))
    assert math.isnan(scoring.to_sce(-1.0, "Ag/Ag+"))
    assert math.isnan(scoring.to_sce(None, "SCE"))  # type: ignore[arg-type]
    assert scoring.from_sce(scoring.to_sce(-1.0, "Fc+/Fc", "DMF"), "Fc+/Fc", "DMF") == -1.0
    assert scoring.clean_ref("vs. Fc/Fc+") == "Fc+/Fc"
    assert scoring.clean_ref("Ag/AgCl (sat. KCl)") == "Ag/AgCl (sat. KCl)"
    assert scoring.clean_ref("Hg/HgO") == "other"
