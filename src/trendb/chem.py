"""RDKit cheminformatics helpers with graceful fallback when RDKit is absent."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

if TYPE_CHECKING:
    from .models import Entry

try:
    from rdkit import Chem, DataStructs
    from rdkit.Chem import AllChem, Descriptors, rdMolDescriptors

    try:
        from rdkit.Chem import rdFingerprintGenerator

        _MORGAN_GEN = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    except Exception:  # pragma: no cover - older RDKit fallback
        _MORGAN_GEN = None
    HAS_RDKIT = True
except ImportError:  # pragma: no cover - environment without RDKit
    Chem = None  # type: ignore[assignment]
    DataStructs = None  # type: ignore[assignment]
    AllChem = None  # type: ignore[assignment]
    Descriptors = None  # type: ignore[assignment]
    rdMolDescriptors = None  # type: ignore[assignment]
    _MORGAN_GEN = None
    HAS_RDKIT = False


def require_rdkit() -> None:
    if not HAS_RDKIT:
        raise ImportError("RDKit is required for chemical structure operations. Install via conda or `pip install trendb[chem]`.")


@lru_cache(maxsize=4096)
def parse_mol(smiles: str, *, is_smarts: bool = False) -> Any | None:
    if not HAS_RDKIT or not smiles or not smiles.strip():
        return None
    s = smiles.strip()
    try:
        mol = Chem.MolFromSmarts(s) if is_smarts else Chem.MolFromSmiles(s)
    except Exception:
        return None
    if mol is None or mol.GetNumAtoms() <= 0:
        return None
    return mol


def structure_ok(smiles: str) -> bool | None:
    """Return True/False if RDKit is available, or None when RDKit is unavailable."""
    if not HAS_RDKIT:
        return None
    return parse_mol(smiles) is not None


@lru_cache(maxsize=4096)
def canonical_smiles(smiles: str, *, isomeric: bool = True) -> str | None:
    mol = parse_mol(smiles)
    if mol is None:
        return None
    try:
        return Chem.MolToSmiles(mol, isomericSmiles=isomeric, canonical=True)
    except Exception:
        return None


@lru_cache(maxsize=4096)
def inchikey(smiles: str) -> str | None:
    mol = parse_mol(smiles)
    if mol is None:
        return None
    try:
        key = Chem.MolToInchiKey(mol)
        return key or None
    except Exception:
        return None


@lru_cache(maxsize=4096)
def morgan_fp(smiles: str) -> Any | None:
    mol = parse_mol(smiles)
    if mol is None:
        return None
    try:
        if _MORGAN_GEN is not None:
            return _MORGAN_GEN.GetFingerprint(mol)
        return AllChem.GetMorganFingerprintAsBitVect(mol, 2, nBits=2048)
    except Exception:
        return None


def tanimoto_similarity(query_smiles: str, target_smiles: str) -> float | None:
    require_rdkit()
    qfp = morgan_fp(query_smiles)
    tfp = morgan_fp(target_smiles)
    if qfp is None or tfp is None:
        return None
    return float(DataStructs.TanimotoSimilarity(qfp, tfp))


def substructure_match(query: str, target_smiles: str, *, smarts: bool = False) -> bool:
    require_rdkit()
    qmol = parse_mol(query, is_smarts=smarts)
    tmol = parse_mol(target_smiles)
    if qmol is None or tmol is None:
        return False
    return bool(tmol.HasSubstructMatch(qmol, useChirality=True))


def exact_match(query_smiles: str, target_smiles: str, *, keep_stereo: bool = True) -> bool:
    """Compare molecules by canonical SMILES (stereo-aware by default)."""
    if not HAS_RDKIT:
        return query_smiles.strip() == target_smiles.strip()
    qc = canonical_smiles(query_smiles, isomeric=keep_stereo)
    tc = canonical_smiles(target_smiles, isomeric=keep_stereo)
    if qc is None or tc is None:
        return False
    return qc == tc


def write_sdf(entries: Iterable[Entry], path: str | Path) -> int:
    """Write entries with valid structures to an SDF file with 2D coordinates."""
    require_rdkit()
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    writer = Chem.SDWriter(str(out_path))
    try:
        for e in entries:
            mol = parse_mol(e.smiles)
            if mol is None:
                continue
            m = Chem.Mol(mol)
            AllChem.Compute2DCoords(m)
            m.SetProp("_Name", e.name or "")
            props = {
                "name": e.name,
                "smiles": e.smiles,
                "et_kcal": e.et_kcal,
                "et_unc": e.et_unc,
                "origin": e.origin,
                "role": e.role,
                "cls": e.cls,
                "cas": e.cas,
                "doi": e.doi,
                "method": e.method,
                "conditions": e.conditions,
                "score": e.score,
                "id": e.id,
            }
            for k, v in props.items():
                if v is not None and v != "":
                    m.SetProp(k, str(v))
            writer.write(m)
            written += 1
    finally:
        writer.close()
    return written


def molecular_descriptors(smiles: str) -> dict[str, float | int] | None:
    """Compute standard physicochemical RDKit descriptors for a SMILES string."""
    require_rdkit()
    mol = parse_mol(smiles)
    if mol is None:
        return None
    return {
        "mol_wt": round(float(Descriptors.MolWt(mol)), 3),
        "exact_mass": round(float(Descriptors.ExactMolWt(mol)), 4),
        "heavy_atoms": int(mol.GetNumHeavyAtoms()),
        "heteroatoms": int(rdMolDescriptors.CalcNumHeteroatoms(mol)),
        "aromatic_rings": int(rdMolDescriptors.CalcNumAromaticRings(mol)),
        "aliphatic_rings": int(rdMolDescriptors.CalcNumAliphaticRings(mol)),
        "hbd": int(rdMolDescriptors.CalcNumHBD(mol)),
        "hba": int(rdMolDescriptors.CalcNumHBA(mol)),
        "rotatable_bonds": int(rdMolDescriptors.CalcNumRotatableBonds(mol)),
        "tpsa": round(float(rdMolDescriptors.CalcTPSA(mol)), 2),
        "clogp": round(float(Descriptors.MolLogP(mol)), 3),
        "fraction_csp3": round(float(rdMolDescriptors.CalcFractionCSP3(mol)), 3),
    }
