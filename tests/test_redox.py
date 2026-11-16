"""Redox potentials: model, filtering, representative values, exp-vs-calc and the public client."""

from __future__ import annotations

import json

import httpx
import pytest

from trendb import (
    RedoxEntry,
    TrEnDBClient,
    compare_exp_calc_redox,
    filter_redox,
    group_redox_by_molecule,
    rep_value,
)

ROWS = [
    {"id": "1", "name": "Ir-F", "cas": "870987-63-6", "smiles": "C", "idcode": "ir", "kind": "red", "state": "S0", "origin": "exp",
     "e_v": -1.37, "e_ref": "SCE", "e_sce": -1.37, "category": "photocatalyst", "uv_lmax": 380},
    {"id": "2", "name": "Ir-F", "cas": "870987-63-6", "smiles": "C", "idcode": "ir", "kind": "red", "state": "S0", "origin": "exp",
     "e_v": -1.75, "e_ref": "Fc+/Fc", "e_sce": -1.37, "solvent": "MeCN", "category": "photocatalyst"},
    {"id": "3", "name": "Ir-F", "cas": "870987-63-6", "smiles": "C", "idcode": "ir", "kind": "red", "state": "S0", "origin": "calc",
     "e_v": -1.50, "e_ref": "SCE", "e_sce": -1.50, "category": "photocatalyst"},
    {"id": "4", "name": "Ir-F", "cas": "870987-63-6", "smiles": "C", "idcode": "ir", "kind": "red", "state": "T1", "origin": "exp",
     "e_v": 1.21, "e_ref": "SCE", "e_sce": 1.21, "excited_from": "estimated", "e00_ev": 2.58, "tau_ns": 2300},
    {"id": "5", "name": "Toluene", "cas": "108-88-3", "smiles": "Cc1ccccc1", "idcode": "tol", "kind": "ox", "state": "S0", "origin": "exp",
     "e_v": 2.39, "e_ref": "Ag/AgCl (3.5 M NaCl)", "e_sce": 2.36, "category": "substrate", "activated_group": "benzylic C-H"},
    {"id": "6", "name": "Odd", "smiles": "CC", "kind": "red", "state": "S0", "origin": "exp", "e_v": -1.0, "e_ref": "Ag/Ag+"},
]


def _rows() -> list[RedoxEntry]:
    return [RedoxEntry.from_dict(r) for r in ROWS]


def test_model_quantity_and_reference_display() -> None:
    r = _rows()
    assert [x.quantity for x in r[:5]] == ["e_red", "e_red", "e_red", "e_star_red", "e_ox"]
    assert r[0].potential() == -1.37
    assert r[0].potential("Fc+/Fc", "MeCN") == -1.75
    assert r[0].potential("NHE") == pytest.approx(-1.129)
    assert r[5].potential() is None            # Ag/Ag+ without concentration: not convertible
    assert r[5].potential("Ag/Ag+") == -1.0    # but shown in its own reference
    assert RedoxEntry.from_dict(r[3].to_dict()) == r[3]


def test_filter_window_in_any_reference() -> None:
    r = _rows()
    assert [x.id for x in filter_redox(r, quantity="e_red")] == ["1", "2", "3", "6"]
    assert [x.id for x in filter_redox(r, category="substrate")] == ["5"]
    # -1.8..-1.7 V vs Fc+/Fc (MeCN) is -1.42..-1.32 V vs SCE; rows without e_sce are left out
    assert [x.id for x in filter_redox(r, e_min=-1.8, e_max=-1.7, ref="Fc+/Fc", solvent="MeCN")] == ["1", "2"]
    assert [x.id for x in filter_redox(r, q="benzylic")] == ["5"]
    assert [x.id for x in filter_redox(r, sort_by="e_desc")][:2] == ["5", "4"]
    assert filter_redox(r, sort_by="e_asc")[-1].id == "6"  # unconverted values go last


def test_representative_value_prefers_experiment() -> None:
    r = _rows()
    rv = rep_value(r, "e_red")
    assert rv is not None and rv.origin == "exp" and rv.n == 2 and rv.mean == -1.37
    calc_only = rep_value([x for x in r if x.origin == "calc"], "e_red")
    assert calc_only is not None and calc_only.origin == "calc" and calc_only.mean == -1.5
    assert rep_value(r, "e_star_ox") is None


def test_grouping_and_exp_vs_calc() -> None:
    mols = {m.display_name: m for m in group_redox_by_molecule(_rows())}
    assert set(mols) == {"Ir-F", "Toluene", "Odd"}
    assert mols["Ir-F"].value("e_red") == -1.37
    assert mols["Ir-F"].value("e_star_red", "Fc+/Fc", "MeCN") == pytest.approx(0.83)
    ec = compare_exp_calc_redox(_rows(), "e_red")
    assert ec.n_molecules == 1 and ec.bias == pytest.approx(-0.13)
    assert "V (vs SCE)" in ec.to_markdown(quantity="e_red", unit="V (vs SCE)", digits=2)


def test_client_fetch_redox_pages_through_list_redox() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        assert request.url.path.endswith("/rest/v1/rpc/list_redox")
        assert json.loads(request.content) == {"p_user": "u", "p_pass": "p"}
        return httpx.Response(200, json=ROWS)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    with TrEnDBClient(supabase_url="https://x.supabase.co", supabase_anon_key="sb_publishable_x",
                      site_user="u", site_pass="p", http_client=http) as client:
        rows = client.fetch_redox()
        assert len(rows) == 6 and isinstance(rows[0], RedoxEntry)
        assert [x.id for x in client.search_redox(kind="ox")] == ["5"]
    assert len(calls) == 1  # one short page, then cached
