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
