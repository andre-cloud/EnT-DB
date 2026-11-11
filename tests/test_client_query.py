"""Tests for TrEnDBClient public DB access, pagination, caching, RDKit queries, and exports."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import httpx
import pytest

from trendb import Entry, MoleculeGroup, TrEnDBClient, TrEnDBError, filter_entries, group_by_molecule, load_config

REPO_ROOT = Path(__file__).resolve().parents[1]


def _make_sample_rows() -> list[dict]:
    return [
        {
            "id": "1",
            "created_at": "2026-01-01T00:00:00Z",
            "name": "Thioxanthone",
            "cas": "492-22-8",
            "smiles": "O=c1c2ccccc2sc2ccccc12",
            "idcode": "id_tx",
            "cls": "Thioxanthones",
            "role": "donor",
            "origin": "exp",
            "et_kcal": 65.5,
            "doi": "10.1021/jacs.0c05069",
            "uv_lmax": 380,
            "uv_eps": 6166,
            "uv_cond": "MeCN",
            "direct_exc": {"LED": 415},
            "score": 89,
        },
        {
            "id": "2",
            "created_at": "2026-01-02T00:00:00Z",
            "name": "Thioxanthone",
            "cas": "492-22-8",
            "smiles": "O=c1c2ccccc2sc2ccccc12",
            "idcode": "id_tx",
            "cls": "Thioxanthones",
            "role": "donor",
            "origin": "calc",
            "et_kcal": 64.1,
            "doi": "10.1021/jacs.0c05069",
            "score": 85,
        },
        {
            "id": "3",
            "created_at": "2026-01-03T00:00:00Z",
            "name": "(E)-Stilbene",
            "cas": "103-30-0",
            "smiles": "C(=C/c1ccccc1)\\c1ccccc1",
            "idcode": "id_estil",
            "cls": "Aryl alkenes",
            "role": "both",
            "origin": "exp",
            "et_kcal": 49.0,
            "doi": "10.1351/pac197541040559",
            "score": 92,
        },
        {
            "id": "4",
            "created_at": "2026-01-04T00:00:00Z",
            "name": "(Z)-Stilbene",
            "cas": "645-49-8",
            "smiles": "C(=C\\c1ccccc1)\\c1ccccc1",
            "idcode": "id_zstil",
            "cls": "Aryl alkenes",
            "role": "acceptor",
            "origin": "exp",
            "et_kcal": 57.0,
            "doi": "10.1351/pac197541040559",
            "score": 88,
        },
    ]


def test_load_config_reads_repo_config_js() -> None:
    cfg = load_config(repo_root=REPO_ROOT)
    assert cfg.is_configured
    assert cfg.supabase_url.startswith("https://")
    assert cfg.supabase_anon_key.startswith("sb_")


def test_load_config_reads_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRENDB_USER", raising=False)
    monkeypatch.delenv("TRENDB_PASS", raising=False)
    monkeypatch.delenv("TRENDB_CURATOR_EMAIL", raising=False)
    monkeypatch.delenv("TRENDB_CURATOR_PASS", raising=False)
    (tmp_path / ".env").write_text(
        'TRENDB_USER="demo"\nTRENDB_PASS=\'secret\'\nTRENDB_CURATOR_EMAIL=cur@example.org\nTRENDB_CURATOR_PASS=pw\n',
        encoding="utf-8",
    )
    cfg = load_config(repo_root=tmp_path)
    assert cfg.site_user == "demo"
    assert cfg.site_pass == "secret"
    assert cfg.curator_email == "cur@example.org"
    assert cfg.curator_pass == "pw"

    # Empty env vars should not shadow .env values
    monkeypatch.setenv("TRENDB_USER", "")
    cfg2 = load_config(repo_root=tmp_path)
    assert cfg2.site_user == "demo"


def test_client_pagination_headers_and_cache(tmp_path: Path) -> None:
    page1 = [
        {
            "id": str(i),
            "created_at": "2026-01-01T00:00:00Z",
            "name": f"Mol {i}",
            "smiles": "C=C",
            "role": "acceptor",
            "origin": "exp",
            "et_kcal": 60.0,
        }
        for i in range(1000)
    ]
    page2 = _make_sample_rows()
    calls: list[tuple[str, dict[str, str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((str(request.url), dict(request.headers)))
        if "offset=0" in str(request.url):
            return httpx.Response(200, json=page1)
        return httpx.Response(200, json=page2)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    cache_file = tmp_path / "cache.json"
    client = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        curator_email="",
        curator_pass="",
        cache_path=cache_file,
        cache_ttl_seconds=3600,
        http_client=http,
    )

    entries = client.fetch_entries()
    assert len(entries) == 1004
    assert len(calls) == 2
    # sb_* publishable keys must NOT be sent as Bearer JWT
    assert "authorization" not in {k.lower() for k in calls[0][1]}
    assert calls[0][1]["apikey"] == "sb_publishable_testkey"

    # Second client with same cache file uses disk cache without hitting network
    client2 = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        curator_email="",
        curator_pass="",
        cache_path=cache_file,
        cache_ttl_seconds=3600,
        http_client=http,
    )
    entries2 = client2.fetch_entries()
    assert len(entries2) == 1004
    assert len(calls) == 2


def test_client_jwt_header_and_gated_error() -> None:
    seen_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        if request.url.path.endswith("/list_entries"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/check_access"):
            return httpx.Response(200, json=False)
        return httpx.Response(404)

    client = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="eyJ_legacy_jwt",
        site_user="",
        site_pass="",
        curator_email="",
        curator_pass="",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert seen_headers == {}
    with pytest.raises(TrEnDBError, match="site_access"):
        client.fetch_entries()
    assert seen_headers.get("authorization") == "Bearer eyJ_legacy_jwt"


def test_query_filters_rdkit_grouping_and_exports(tmp_path: Path) -> None:
    rows = _make_sample_rows()
    client = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_test",
        curator_email="",
        curator_pass="",
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda req: httpx.Response(200, json=rows))
        ),
    )

    # Role 'donor' matches both 'donor' and 'both'
    donors = client.query().role("donor").origin("exp").all()
    assert [e.name for e in donors] == ["Thioxanthone", "(E)-Stilbene"]

    # Unit conversion: 2.5 to 3.0 eV -> ~57.65 to 69.18 kcal/mol
    ev_hits = client.query().et_between(2.5, 3.0, unit="ev").origin("exp").all()
    assert [e.name for e in ev_hits] == ["Thioxanthone"]

    # Substructure search for thioxanthone core via SMILES
    sub_hits = client.query().substructure("O=c1c2ccccc2sc2ccccc12").all()
    assert len(sub_hits) == 2

    # Exact stereo search separates (E)- and (Z)-stilbene
    exact_e = client.query().exact("C(=C/c1ccccc1)\\c1ccccc1").all()
    assert [e.name for e in exact_e] == ["(E)-Stilbene"]

    # Similarity search
    sim_hits = client.query().similarity("O=c1c2ccccc2oc2ccccc12", threshold=0.25).execute()
    assert len(sim_hits) >= 1
    assert sim_hits[0].similarity is not None

    # Grouping keeps E/Z separate and groups both Thioxanthone entries onto 1 card
    groups = client.group_by_molecule()
    assert len(groups) == 3
    assert len(groups[0].entries) == 2

    # Exports (CSV, JSON, DataFrame, SDF)
    res = client.search(origin="exp")
    csv_path = res.to_csv(tmp_path / "out.csv")
    with csv_path.open(encoding="utf-8") as fh:
        csv_rows = list(csv.DictReader(fh))
    assert len(csv_rows) == 3

    json_path = res.to_json(tmp_path / "out.json")
    assert len(json.loads(json_path.read_text(encoding="utf-8"))) == 3

    df = res.to_dataframe()
    assert len(df) == 3
    assert set(df["origin"]) == {"exp"}

    sdf_count = res.to_sdf(tmp_path / "out.sdf")
    assert sdf_count == 3
    assert (tmp_path / "out.sdf").is_file()


def test_offline_from_real_batches() -> None:
    client = TrEnDBClient.from_batches(REPO_ROOT / "docs" / "batches")
    entries = client.fetch_entries()
    assert len(entries) >= 187
    tx = client.query().substructure("O=c1c2ccccc2sc2ccccc12").all()
    assert len(tx) >= 10


def test_curator_auth_fallback_when_email_in_site_user() -> None:
    rows = _make_sample_rows()
    calls: list[tuple[str, str, dict[str, str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url), dict(request.headers)))
        if request.url.path.endswith("/list_entries"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/check_access"):
            return httpx.Response(200, json=False)
        if request.url.path.endswith("/auth/v1/token"):
            payload = json.loads(request.content.decode("utf-8"))
            assert payload == {"email": "curator@example.org", "password": "pw"}
            return httpx.Response(200, json={"access_token": "jwt_curator_tok"})
        if request.url.path.endswith("/is_admin"):
            assert request.headers.get("authorization") == "Bearer jwt_curator_tok"
            return httpx.Response(200, json=True)
        if request.url.path.endswith("/rest/v1/entries"):
            assert request.headers.get("authorization") == "Bearer jwt_curator_tok"
            assert "status=eq.approved" in str(request.url)
            return httpx.Response(200, json=rows)
        return httpx.Response(404)

    client = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        site_user="curator@example.org",
        site_pass="pw",
        curator_email="",
        curator_pass="",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    entries = client.fetch_entries()
    assert len(entries) == 4
    assert [c[0] for c in calls] == ["POST", "POST", "POST", "POST", "GET"]


def test_explicit_curator_auth_and_error_cases() -> None:
    rows = _make_sample_rows()
    seen_paths: list[str] = []

    def ok_handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.endswith("/auth/v1/token"):
            return httpx.Response(200, json={"access_token": "tok"})
        if request.url.path.endswith("/is_admin"):
            return httpx.Response(200, json=True)
        if request.url.path.endswith("/rest/v1/entries"):
            return httpx.Response(200, json=rows)
        return httpx.Response(404)

    c_ok = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        curator_email="curator@example.org",
        curator_pass="pw",
        http_client=httpx.Client(transport=httpx.MockTransport(ok_handler)),
    )
    assert len(c_ok.fetch_entries()) == 4
    assert seen_paths == ["/auth/v1/token", "/rest/v1/rpc/is_admin", "/rest/v1/entries"]

    def not_admin_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/v1/token"):
            return httpx.Response(200, json={"access_token": "tok"})
        if request.url.path.endswith("/is_admin"):
            return httpx.Response(200, json=False)
        return httpx.Response(404)

    c_non_admin = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        curator_email="user@example.org",
        curator_pass="pw",
        http_client=httpx.Client(transport=httpx.MockTransport(not_admin_handler)),
    )
    with pytest.raises(TrEnDBError, match="public\\.admins"):
        c_non_admin.fetch_entries()

    def bad_pw_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/list_entries"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/check_access"):
            return httpx.Response(200, json=False)
        if request.url.path.endswith("/auth/v1/token"):
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(404)

    c_bad_pw = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        site_user="curator@example.org",
        site_pass="wrong",
        curator_email="",
        curator_pass="",
        http_client=httpx.Client(transport=httpx.MockTransport(bad_pw_handler)),
    )
    with pytest.raises(TrEnDBError, match="site_access"):
        c_bad_pw.fetch_entries()


def test_commercial_name_model_grouping_and_filter() -> None:
    e_with = Entry.from_dict({
        "id": "10",
        "name": "thioxanthen-9-one",
        "commercial_name": "Thioxanthone",
        "smiles": "O=c1c2ccccc2sc2ccccc12",
        "idcode": "id_tx",
        "et_kcal": 65.5,
        "origin": "exp",
        "role": "donor",
    })
    e_no_comm = Entry.from_dict({
        "id": "11",
        "name": "thioxanthen-9-one",
        "smiles": "O=c1c2ccccc2sc2ccccc12",
        "idcode": "id_tx",
        "et_kcal": 64.1,
        "origin": "calc",
        "role": "donor",
    })
    e_other = Entry.from_dict({
        "id": "12",
        "name": "diphenylmethanone",
        "smiles": "O=C(c1ccccc1)c1ccccc1",
        "idcode": "id_bp",
        "et_kcal": 68.5,
        "origin": "exp",
        "role": "donor",
    })

    assert e_with.display_name == "Thioxanthone"
    assert e_no_comm.display_name == "thioxanthen-9-one"
    assert e_other.commercial_name is None

    groups = group_by_molecule([e_no_comm, e_with, e_other])
    tx_group = next(g for g in groups if g.name == "thioxanthen-9-one")
    bp_group = next(g for g in groups if g.name == "diphenylmethanone")
    assert isinstance(tx_group, MoleculeGroup)
    assert tx_group.commercial_name == "Thioxanthone"
    assert tx_group.display_name == "Thioxanthone"
    assert bp_group.commercial_name is None
    assert bp_group.display_name == "diphenylmethanone"

    assert [e.id for e in filter_entries([e_with, e_other], q="Thioxanthone")] == ["10"]
    assert [e.id for e in filter_entries([e_with, e_no_comm, e_other], q="thioxanthen")] == ["10", "11"]


def test_curator_fetch_falls_back_when_commercial_name_missing() -> None:
    rows = _make_sample_rows()
    selects: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/v1/token"):
            return httpx.Response(200, json={"access_token": "tok"})
        if request.url.path.endswith("/is_admin"):
            return httpx.Response(200, json=True)
        if request.url.path.endswith("/rest/v1/entries"):
            sel = request.url.params.get("select", "")
            selects.append(sel)
            if "commercial_name" in sel:
                return httpx.Response(400, json={"code": "42703", "message": "column entries.commercial_name does not exist"})
            return httpx.Response(200, json=rows)
        return httpx.Response(404)

    client = TrEnDBClient(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="sb_publishable_testkey",
        curator_email="curator@example.org",
        curator_pass="pw",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    entries = client.fetch_entries()
    assert len(entries) == 4
    assert len(selects) == 2
    assert "commercial_name" in selects[0]
    assert "commercial_name" not in selects[1]
