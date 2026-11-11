"""Data models matching TrEnDB public_entries and docs/batches schema."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

KJ_PER_KCAL = 4.184
KCAL_PER_EV = 23.0605

# Exact 26-key uniform schema from docs/batches/batch-001.json plus optional "cas".
BATCH_ROW_KEYS: tuple[str, ...] = (
    "import_key",
    "name",
    "cas",
    "smiles",
    "smiles_checked",
    "structure_note",
    "cls",
    "role",
    "origin",
    "et_kcal",
    "et_unc",
    "et_reported",
    "et_type",
    "method",
    "conditions",
    "citation",
    "doi",
    "location",
    "quote",
    "evidence",
    "verify_level",
    "verify_note",
    "uv_lmax",
    "uv_eps",
    "uv_cond",
    "direct_exc",
    "source_kind",
    "score",
    "score_items",
)


@dataclass
class UseReference:
    doi: str
    note: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"doi": self.doi, "note": self.note}


@dataclass
class ScoreItem:
    label: str
    got: int
    max: int
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"label": self.label, "got": self.got, "max": self.max, "note": self.note}


@dataclass
class Entry:
    """Represents a TrEnDB public entry (or batch literature entry)."""

    name: str
    smiles: str
    role: str
    origin: str
    et_kcal: float
    id: str | None = None
    created_at: str | None = None
    cas: str | None = None
    idcode: str | None = None
    structure_note: str | None = None
    cls: str | None = None
    et_unc: float | None = None
    et_reported: str | None = None
    et_type: str | None = None
    method: str | None = None
    conditions: str | None = None
    citation: str | None = None
    doi: str | None = None
    location: str | None = None
    quote: str | None = None
    evidence: str | None = None
    verify_level: str | None = None
    verify_note: str | None = None
    uv_lmax: int | None = None
    uv_eps: int | None = None
    uv_cond: str | None = None
    direct_exc: dict[str, int] | None = None
    score: int | None = None
    uses: list[dict[str, str]] | None = None
    # Batch / review metadata (present in local batch JSONs, omitted from public_entries view)
    import_key: str | None = None
    smiles_checked: bool | None = None
    source_kind: str | None = None
    score_items: list[dict[str, Any]] | None = None
    # Optional runtime annotation (e.g., similarity search score)
    similarity: float | None = field(default=None, repr=False)

    @property
    def et_kj(self) -> float:
        return self.et_kcal * KJ_PER_KCAL

    @property
    def et_ev(self) -> float:
        return self.et_kcal / KCAL_PER_EV

    @property
    def doi_url(self) -> str | None:
        return f"https://doi.org/{self.doi}" if self.doi else None

    @property
    def uv_lambda_max(self) -> int | None:
        return self.uv_lmax

    @property
    def uv_epsilon(self) -> int | None:
        return self.uv_eps

    @property
    def uv_condi(self) -> str | None:
        return self.uv_cond

    @property
    def direct_excitation(self) -> dict[str, int] | None:
        return self.direct_exc

    @property
    def uv(self) -> str | None:
        parts = []
        if self.uv_lmax is not None:
            parts.append(f"λmax {self.uv_lmax} nm")
        if self.uv_eps is not None:
            parts.append(f"ε {self.uv_eps:,} M⁻¹ cm⁻¹")
        base = " · ".join(parts)
        if self.uv_cond:
            base = f"{base} ({self.uv_cond})" if base else self.uv_cond
        return base or None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Entry":
        from .clean_fields import parse_direct_exc, parse_uv_fields

        et_val = data.get("et_kcal")
        unc_val = data.get("et_unc")
        uv_lmax = int(data["uv_lmax"]) if data.get("uv_lmax") is not None else None
        uv_eps = int(data["uv_eps"]) if data.get("uv_eps") is not None else None
        uv_cond = data.get("uv_cond")
        if uv_lmax is None and uv_cond is None and data.get("uv"):
            uv_lmax, uv_eps_p, uv_cond = parse_uv_fields(str(data["uv"]))
            if uv_eps is None:
                uv_eps = uv_eps_p
        dir_exc = parse_direct_exc(data.get("direct_exc"))
        return cls(
            id=data.get("id"),
            created_at=data.get("created_at"),
            name=str(data.get("name") or ""),
            cas=data.get("cas"),
            smiles=str(data.get("smiles") or ""),
            idcode=data.get("idcode"),
            structure_note=data.get("structure_note"),
            cls=data.get("cls"),
            role=str(data.get("role") or "acceptor"),
            origin=str(data.get("origin") or "exp"),
            et_kcal=float(et_val) if et_val is not None else float("nan"),
            et_unc=float(unc_val) if unc_val is not None else None,
            et_reported=data.get("et_reported"),
            et_type=data.get("et_type"),
            method=data.get("method"),
            conditions=data.get("conditions"),
            citation=data.get("citation"),
            doi=data.get("doi"),
            location=data.get("location"),
            quote=data.get("quote"),
            evidence=data.get("evidence"),
            verify_level=data.get("verify_level"),
            verify_note=data.get("verify_note"),
            uv_lmax=uv_lmax,
            uv_eps=uv_eps,
            uv_cond=uv_cond,
            direct_exc=dir_exc,
            score=int(data["score"]) if data.get("score") is not None else None,
            uses=data.get("uses"),
            import_key=data.get("import_key"),
            smiles_checked=data.get("smiles_checked"),
            source_kind=data.get("source_kind"),
            score_items=data.get("score_items"),
            similarity=data.get("similarity"),
        )

    def to_dict(self, include_similarity: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "created_at": self.created_at,
            "name": self.name,
            "cas": self.cas,
            "smiles": self.smiles,
            "idcode": self.idcode,
            "structure_note": self.structure_note,
            "cls": self.cls,
            "role": self.role,
            "origin": self.origin,
            "et_kcal": self.et_kcal,
            "et_unc": self.et_unc,
            "et_reported": self.et_reported,
            "et_type": self.et_type,
            "method": self.method,
            "conditions": self.conditions,
            "citation": self.citation,
            "doi": self.doi,
            "location": self.location,
            "quote": self.quote,
            "evidence": self.evidence,
            "verify_level": self.verify_level,
            "verify_note": self.verify_note,
            "uv_lmax": self.uv_lmax,
            "uv_eps": self.uv_eps,
            "uv_cond": self.uv_cond,
            "direct_exc": self.direct_exc,
            "score": self.score,
            "uses": self.uses,
        }
        if self.import_key is not None:
            out["import_key"] = self.import_key
        if self.smiles_checked is not None:
            out["smiles_checked"] = self.smiles_checked
        if self.source_kind is not None:
            out["source_kind"] = self.source_kind
        if self.score_items is not None:
            out["score_items"] = self.score_items
        if include_similarity and self.similarity is not None:
            out["similarity"] = self.similarity
        return out


@dataclass
class MoleculeGroup:
    """All entries belonging to a single unique molecule."""

    cas: str | None
    name: str
    smiles: str
    idcode: str | None
    entries: list[Entry]

    @property
    def et_min(self) -> float:
        return min(e.et_kcal for e in self.entries)

    @property
    def et_max(self) -> float:
        return max(e.et_kcal for e in self.entries)
