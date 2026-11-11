"""Tests for connected metal-complex SMILES across batch data, RDKit, and Resolver."""

from __future__ import annotations

import json
import re
from pathlib import Path

from trendb import chem
from trendb.batch import validate_batch_rows
from trendb.resolvers import Resolver

REPO_ROOT = Path(__file__).resolve().parents[1]
BATCH_001 = REPO_ROOT / "docs" / "batches" / "batch-001.json"


def test_batch_001_metal_complexes_are_coordinated_and_valid_in_rdkit() -> None:
    rows = json.loads(BATCH_001.read_text(encoding="utf-8"))
    assert validate_batch_rows(rows) == []

    metal_rows = [r for r in rows if re.search(r"\[(Ir|Ru|Pt|Pd|Cu|Fe|Os|Re|Zn|Co|Ni)", r["smiles"])]
    assert len(metal_rows) == 8

    for r in metal_rows:
        smi = r["smiles"]
        # Must be connected single coordination entity (no disconnected metal ion + ligand fragments)
        assert "." not in smi, f"{r['import_key']} still uses disconnected fragments: {smi}"
        assert "->" in smi or "<-" in smi, f"{r['import_key']} missing dative coordination bonds: {smi}"
        if chem.HAS_RDKIT:
            assert chem.structure_ok(smi) is True
            can = chem.canonical_smiles(smi, isomeric=True)
            assert can is not None
            assert chem.morgan_fp(smi) is not None
            desc = chem.molecular_descriptors(smi)
            assert desc is not None and desc["mol_wt"] > 300


def test_resolver_builtin_metal_photocatalysts_offline() -> None:
    with Resolver(cache_path=None, batches_dir=None, offline=True) as resolver:
        for name in ("Ir(ppy)3", "fac-Ir(ppy)3", "Ru(bpy)3", "[Ir(dF(CF3)ppy)2(dtbbpy)]+"):
            res = resolver.resolve_molecule(name, lookup_cas=False)
            assert res.smiles is not None, f"Failed to resolve {name}"
            assert "." not in res.smiles
            assert "->" in res.smiles or "<-" in res.smiles
            if chem.HAS_RDKIT:
                assert chem.structure_ok(res.smiles) is True
