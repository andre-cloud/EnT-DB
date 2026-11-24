"""PhotoTool maths in Python: the same cases as tools/test-redox.mjs, plus the advisor on database molecules."""

from __future__ import annotations

import math

import pytest

from trendb import (
    Partner,
    Photocatalyst,
    TrEnDBClient,
    best_cycle,
    coulomb,
    cycles,
    e00_from,
    e00_from_spectra,
    excited_potentials,
    load_reactions,
    photon_energy,
    photon_flux,
    quench_dg,
    rank_photocatalysts,
    reactions_for,
    substrates_in_reach,
)

PC = {"e_ox": 0.8, "e_red": -1.4, "e_star_ox": -1.7, "e_star_red": 1.1}
D = {"name": "amine", "E_ox": 0.9}
A = {"name": "halide", "E_red": -1.2}


def test_cycles_dg_and_verdicts() -> None:
    cs = cycles(PC, D, A, "donor")
    red = next(c for c in cs if c.mode == "reductive")
    ox = next(c for c in cs if c.mode == "oxidative")
    assert red.steps[0].g == pytest.approx(0.9 - 1.1)
    assert red.steps[1].g == pytest.approx(-1.4 - -1.2)
    assert ox.steps[0].g == pytest.approx(-1.7 - -1.2)
    assert ox.steps[1].g == pytest.approx(0.9 - 0.8)
    assert red.verdict == "good" and ox.verdict == "border"
    assert cs[0].mode == "reductive"


@pytest.mark.parametrize("g,verdict", [(-0.05, "good"), (0.15, "border"), (0.16, "bad")])
def test_thresholds(g: float, verdict: str) -> None:
    c = cycles({"e_star_red": 1.0, "e_red": -5}, {"name": "d", "E_ox": 1.0 + g}, {"name": "a", "E_red": 0}, "donor")[0]
    assert c.verdict == verdict


def test_soft_and_missing_steps() -> None:
    soft = cycles({"e_star_red": 1.0, "e_red": -2}, {"name": "d", "E_ox": 0.5, "soft": True}, {"name": "a", "E_red": -1}, "acceptor")[0]
    assert soft.verdict == "border"  # an estimated photochemical step cannot make a cycle feasible
    assert cycles({"e_star_red": 1.0}, None, {"name": "a", "E_red": -1}, "donor")[0].verdict == "unknown"
    assert best_cycle({"e_star_red": 1.0}, None, None, None, "donor") is None


def test_reported_mechanism_breaks_ties() -> None:
    twin = Photocatalyst(e_ox=1.0, e_red=-1.0, e_star_ox=-1.5, e_star_red=1.5)
    d, a = Partner("d", E_ox=0.5), Partner("a", E_red=-0.5)
    assert best_cycle(twin, d, a, "oxidative", "donor").mode == "oxidative"  # type: ignore[union-attr]
    assert best_cycle(twin, d, a, "reductive", "donor").mode == "reductive"  # type: ignore[union-attr]


def test_excited_state_potentials_and_quenching() -> None:
    eso, esr = excited_potentials(0.77, -1.33, 2.1)
    assert eso == pytest.approx(0.77 - 2.1) and esr == pytest.approx(-1.33 + 2.1)
    assert excited_potentials(None, -1, 2)[0] is None
    assert e00_from(450, "nm") == pytest.approx(1239.84 / 450)
    assert e00_from(63.3, "kcal") == pytest.approx(63.3 / 23.0605)
    assert e00_from(-1, "ev") is None
    assert coulomb(37.5, 7) == pytest.approx(-14.4 / (37.5 * 7))
    q = quench_dg(0.8, -1.5, -1.7, 1.12, -0.05)
    assert q["reductive"] == pytest.approx(0.8 - 1.12 - 0.05)
    assert q["oxidative"] == pytest.approx(-1.7 - -1.5 - 0.05)


def test_spectra_crossing_and_units() -> None:
    xs = list(range(350, 701))
    gauss = lambda c: [math.exp(-((w - c) ** 2) / (2 * 30**2)) for w in xs]  # noqa: E731
    e00, lam = e00_from_spectra(xs, gauss(450), xs, gauss(550))
    assert lam == pytest.approx(500, abs=0.5) and e00 == pytest.approx(1239.84 / lam)
    with pytest.raises(ValueError):
        e00_from_spectra(xs, gauss(550), xs, gauss(450))
    assert photon_flux(100, 450) == pytest.approx(3.7617e-7, abs=1e-10)
    assert photon_energy(450)["ev"] == pytest.approx(2.7552, abs=1e-4)


def test_reaction_library_parses_like_the_site() -> None:
    lib = load_reactions()
    assert len(lib) == 23 and len({r.id for r in lib}) == 23
    for r in lib:
        assert r.key in ("donor", "acceptor") and r.reported_quenching in ("reductive", "oxidative")
        key_e = r.donor.E_ox if r.key == "donor" else r.acceptor.E_red
        assert isinstance(key_e, float) and abs(key_e) < 4
    order = ["good", "border", "bad", "unknown"]
    verdicts = [m.verdict for m in reactions_for(PC, lib)]
    assert verdicts and verdicts == sorted(verdicts, key=order.index)


# ---------------- advisor on database molecules (offline client) ----------------

SMILES = {"IrPC": "c1ccncc1", "UVPC": "O=C1c2ccccc2C(=O)c2ccccc12", "Amine": "CCN(CC)CC", "Halide": "Brc1ccccc1", "Hard": "c1ccccc1"}


def _row(i: int, name: str, kind: str, state: str, e: float, **kw: object) -> dict:
    return {"id": str(i), "name": name, "smiles": SMILES[name], "kind": kind, "state": state, "origin": "exp",
            "e_v": e, "e_ref": "SCE", "e_sce": e, **kw}


ROWS = [
    _row(1, "IrPC", "red", "T1", 1.21, category="photocatalyst", uv_lmax=420, tau_ns=2300),
    _row(2, "IrPC", "ox", "T1", -0.89, category="photocatalyst"),
    _row(3, "IrPC", "red", "S0", -1.37, category="photocatalyst"),
    _row(4, "IrPC", "ox", "S0", 1.69, category="photocatalyst"),
    _row(5, "UVPC", "red", "S1", 2.0, category="photocatalyst", uv_lmax=330),
    _row(6, "UVPC", "red", "S0", -1.0, category="photocatalyst"),
    _row(7, "Amine", "ox", "S0", 0.9, category="substrate"),
    _row(8, "Halide", "red", "S0", -1.2, category="substrate"),
    _row(9, "Hard", "red", "S0", -2.6, category="substrate"),
]


@pytest.fixture()
def client() -> TrEnDBClient:
    return TrEnDBClient.from_records(redox=ROWS)


def test_catalogue_and_reach(client: TrEnDBClient) -> None:
    assert [m.display_name for m in client.photocatalysts()] == ["IrPC", "UVPC"]
    assert {m.display_name for m in client.substrates()} == {"Amine", "Halide", "Hard"}
    reach = client.substrates_in_reach("IrPC")
    assert reach[0].molecule.display_name == "Amine" and reach[0].how.startswith("PC•+ oxidises it")
    assert reach[0].dg == pytest.approx(0.9 - 1.69)
    assert any(x.how == "PC* oxidises it" and x.dg == pytest.approx(0.9 - 1.21) for x in reach)
    assert "Hard" not in {x.molecule.display_name for x in reach}
    assert substrates_in_reach(Photocatalyst(e_star_red=1.0), client.substrates(), max_dg=0.0)[0].dg == pytest.approx(-0.1)


def test_rank_for_a_substrate(client: TrEnDBClient) -> None:
    ranks = client.rank_photocatalysts(substrate="Amine", partner="Halide")
    assert [r.photocatalyst.display_name for r in ranks] == ["IrPC", "UVPC"]
    assert ranks[0].verdict == "good" and ranks[0].cycle.complete
    assert "UV" in ranks[1].warnings[0] and ranks[1].overkill  # 0.9 − 2.0 = −1.1 eV < −0.8
    assert [r.photocatalyst.display_name for r in client.rank_photocatalysts(substrate="Amine", visible_only=True)] == ["IrPC"]
    # the same substrate typed against Fc+/Fc (MeCN): 0.52 V vs Fc is 0.90 V vs SCE
    typed = client.rank_photocatalysts(substrate_e=0.52, ref="Fc+/Fc", solvent="MeCN", direction="ox")
    typed_ir = next(r for r in typed if r.photocatalyst.display_name == "IrPC")
    assert typed_ir.cycle.steps[0].g == pytest.approx(0.9 - 1.21, abs=1e-6)
    # a hard reduction: only the strong excited-state reductant gets close
    hard = rank_photocatalysts(client.photocatalysts(), substrate_e=-2.6, direction="red")
    assert hard[0].photocatalyst.display_name == "IrPC" and hard[0].verdict == "bad"


def test_rank_for_a_library_reaction(client: TrEnDBClient) -> None:
    ranks = client.rank_photocatalysts("decarbox-arylation-ni")
    assert ranks and ranks[0].photocatalyst.display_name == "IrPC"
    assert ranks[0].to_dict()["mode"] in ("reductive", "oxidative")
    with pytest.raises(Exception, match="Unknown reaction"):
        client.rank_photocatalysts("no-such-reaction")
    assert client.reactions_for("IrPC")[0].verdict in ("good", "border")
