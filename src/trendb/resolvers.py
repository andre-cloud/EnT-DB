"""Cached, rate-limited chemical and bibliographic resolvers (local DB, OPSIN, PubChem, Crossref, doi.org)."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import httpx

from . import chem
from .scoring import cas_valid, clean_cas, clean_doi, is_doi

# Common photocatalyst / sensitizer / quencher names & abbreviations fallback seed
BUILTIN_MOLECULES: dict[str, str] = {
    "benzophenone": "O=C(c1ccccc1)c1ccccc1",
    "bp": "O=C(c1ccccc1)c1ccccc1",
    "acetophenone": "CC(=O)c1ccccc1",
    "xanthone": "O=c1c2ccccc2oc2ccccc12",
    "thioxanthone": "O=c1c2ccccc2sc2ccccc12",
    "tx": "O=c1c2ccccc2sc2ccccc12",
    "2-isopropylthioxanthone": "O=c1c2cc(C(C)C)ccc2sc2ccccc12",
    "itx": "O=c1c2cc(C(C)C)ccc2sc2ccccc12",
    "9-fluorenone": "O=C1c2ccccc2-c2ccccc12",
    "fluorenone": "O=C1c2ccccc2-c2ccccc12",
    "naphthalene": "c1ccc2ccccc2c1",
    "anthracene": "c1ccc2cc3ccccc3cc2c1",
    "phenanthrene": "c1ccc2c(c1)ccc1ccccc12",
    "pyrene": "c1cc2ccc3cccc4ccc(c1)c2c34",
    "perylene": "c1cc2cccc3c4cccc5cccc(c(c1)c23)c54",
    "biphenyl": "c1ccc(-c2ccccc2)cc1",
    "styrene": "C=Cc1ccccc1",
    "(e)-stilbene": "C(=C/c1ccccc1)\\c1ccccc1",
    "trans-stilbene": "C(=C/c1ccccc1)\\c1ccccc1",
    "(z)-stilbene": "C(=C\\c1ccccc1)\\c1ccccc1",
    "cis-stilbene": "C(=C\\c1ccccc1)\\c1ccccc1",
    "biacetyl": "CC(=O)C(C)=O",
    "2,3-butanedione": "CC(=O)C(C)=O",
    "4czipn": "N#Cc1c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(C#N)c1N1c2ccccc2c2ccccc21",
    "carbazole": "c1ccc2c(c1)[nH]c1ccccc21",
    "benzene": "c1ccccc1",
    "toluene": "Cc1ccccc1",
    "acetone": "CC(C)=O",
    "coumarin": "O=c1ccc2ccccc2o1",
    "chalcone": "O=C(/C=C/c1ccccc1)c1ccccc1",
    "triphenylene": "c1ccc2c(c1)c1ccccc1c1ccccc21",
    "chrysene": "c1ccc2c(c1)ccc1c3ccccc3ccc21",
    "benzil": "O=C(C(=O)c1ccccc1)c1ccccc1",
    "acridine": "c1ccc2nc3ccccc3cc2c1",
    "duroquinone": "CC1=C(C)C(=O)C(C)=C(C)C1=O",
    "2,3-dimethyl-1,4-benzoquinone": "CC1=C(C)C(=O)C=CC1=O",
    "2,5-dimethyl-1,4-benzoquinone": "CC1=CC(=O)C(C)=CC1=O",
    "1,4-benzoquinone": "O=C1C=CC(=O)C=C1",
    "1,4-naphthoquinone": "O=C1C=CC(=O)c2ccccc21",
    "benzanthrone": "O=C1c2ccccc2-c2cccc3cccc1c23",
    "2,2'-binaphthyl": "c1ccc2cc(-c3ccc4ccccc4c3)ccc2c1",
    "1-chloronaphthalene": "Clc1cccc2ccccc12",
    "1-bromonaphthalene": "Brc1cccc2ccccc12",
    "2-acetonaphthone": "CC(=O)c1ccc2ccccc2c1",
    "1-naphthyl phenyl ketone": "O=C(c1ccccc1)c1cccc2ccccc12",
    "cis-1,2-diphenylpropene": "C/C(=C/c1ccccc1)c1ccccc1",
    "trans-1,2-diphenylpropene": "C/C(=C\\c1ccccc1)c1ccccc1",
    "9,10-dibromoanthracene": "Brc1c2ccccc2c(Br)c2ccccc12",
    "chloranil": "O=C1C(Cl)=C(Cl)C(=O)C(Cl)=C1Cl",
    "benz[a]anthracene": "c1ccc2cc3c(ccc4ccccc43)cc2c1",
    "1,2-benzanthracene": "c1ccc2cc3c(ccc4ccccc43)cc2c1",
    "dibenz[a,h]anthracene": "c1ccc2c(c1)ccc1cc3c(ccc4ccccc43)cc12",
    "1,2,5,6-dibenzanthracene": "c1ccc2c(c1)ccc1cc3c(ccc4ccccc43)cc12",
    "dibenz[a,c]anthracene": "c1ccc2cc3c4ccccc4c4ccccc4c3cc2c1",
    "1,2,3,4-dibenzanthracene": "c1ccc2cc3c4ccccc4c4ccccc4c3cc2c1",
    "benzo[a]pyrene": "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34",
    "3,4-benzpyrene": "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34",
    "7,12-dimethylbenz[a]anthracene": "Cc1c2ccccc2c(C)c2c1ccc1ccccc12",
    "9,10-dimethyl-1,2-benzanthracene": "Cc1c2ccccc2c(C)c2c1ccc1ccccc12",
    "1-acetylpyrene": "CC(=O)c1ccc2ccc3cccc4ccc1c2c34",
    "3-acetylpyrene": "CC(=O)c1ccc2ccc3cccc4ccc1c2c34",
    "trans,trans-1,4-diphenyl-1,3-butadiene": "C(/C=C/c1ccccc1)=C\\c1ccccc1",
    "michler's ketone": "CN(C)c1ccc(C(=O)c2ccc(N(C)C)cc2)cc1",
    "ir(ppy)3": "[Ir]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)c1ccccc1-c1ccccn->31",
    "fac-ir(ppy)3": "[Ir]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)c1ccccc1-c1ccccn->31",
    "ir(dfppy)3": "[Ir]123(c4cc(F)cc(F)c4-c4ccccn->14)(c1cc(F)cc(F)c1-c1ccccn->21)c1cc(F)cc(F)c1-c1ccccn->31",
    "fac-ir(dfppy)3": "[Ir]123(c4cc(F)cc(F)c4-c4ccccn->14)(c1cc(F)cc(F)c1-c1ccccn->21)c1cc(F)cc(F)c1-c1ccccn->31",
    "ru(bpy)3": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "[ru(bpy)3]2+": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "ru(bpy)3(pf6)2": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "[ir(df(cf3)ppy)2(dtbbpy)]+": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(cf3)ppy)2(dtbbpy)]pf6": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(me)ppy)2(dtbbpy)]+": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C)cn->14)(c1cc(F)cc(F)c1-c1ccc(C)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(me)ppy)2(dtbbpy)]pf6": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C)cn->14)(c1cc(F)cc(F)c1-c1ccc(C)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
}

_TRAILING_LABEL_RE = re.compile(r"\s*\((?![ezrs]\)|[ezrs],)[^()]*\)\s*$", re.IGNORECASE)
_ANONYMOUS_LABEL_RE = re.compile(
    r"^(?:compound|compd|entry|substrate|catalyst|sensitizer|donor|acceptor|complex|molecule|mol|cat|ps|s|a|d)?\s*"
    r"(?:\d+[a-z]{0,3}|[a-z]\d{1,2}|[ivx]+)$",
    re.IGNORECASE,
)


def normalize_name_key(name: str) -> str:
    """Match Ent.nameKey normalization from docs/assets/common.js."""
    t = (name or "").lower().replace("′", "'").replace("’", "'")
    for _ in range(3):
        t = _TRAILING_LABEL_RE.sub("", t)
    return re.sub(r'[\s"“”]+', "", t).strip()


def looks_like_anonymous_label(name: str) -> bool:
    """Return True if a name is only a paper-local identifier like '4a', 'C1', 'compd 2b'."""
    t = (name or "").strip()
    if not t or len(t) <= 1:
        return True
    return bool(_ANONYMOUS_LABEL_RE.match(t))


@dataclass
class ResolvedMolecule:
    smiles: str | None
    cas: str | None = None
    source: str = ""
    cls_hint: str | None = None
    role_hint: str | None = None
    iupac_name: str | None = None
    warnings: list[str] = field(default_factory=list)


class _RateLimiter:
    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            delta = self._min_interval - (now - self._last)
            if delta > 0:
                time.sleep(delta)
            self._last = time.monotonic()


class _SqliteCache:
    def __init__(self, path: str | Path | None) -> None:
        self._conn: sqlite3.Connection | None = None
        if path is None:
            return
        p = str(path)
        if p != ":memory:":
            Path(p).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(p)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS kv_cache (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY (namespace, key))"
        )
        self._conn.commit()

    def get(self, namespace: str, key: str) -> tuple[bool, Any]:
        if self._conn is None:
            return False, None
        row = self._conn.execute(
            "SELECT value FROM kv_cache WHERE namespace = ? AND key = ?", (namespace, key)
        ).fetchone()
        if row is None:
            return False, None
        return True, json.loads(row[0])

    def set(self, namespace: str, key: str, value: Any) -> None:
        if self._conn is None:
            return
        self._conn.execute(
            "INSERT OR REPLACE INTO kv_cache (namespace, key, value) VALUES (?, ?, ?)",
            (namespace, key, json.dumps(value, ensure_ascii=False)),
        )
        self._conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


class Resolver:
    """Resolves chemical names/CAS -> SMILES/CAS and DOIs -> citations/status."""

    def __init__(
        self,
        *,
        cache_path: str | Path | None = ".cache/trendb_resolvers.sqlite",
        batches_dir: str | Path | None = "docs/batches",
        extra_entries: Iterable[dict[str, Any]] | None = None,
        offline: bool = False,
        pubchem_interval: float = 0.25,
        timeout: float = 12.0,
        mailto: str = "trendb-extract@users.noreply.github.com",
        http_client: httpx.Client | None = None,
    ) -> None:
        self.offline = offline
        self._cache = _SqliteCache(cache_path)
        self._pubchem_rl = _RateLimiter(pubchem_interval)
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(
            timeout=timeout,
            headers={"User-Agent": f"TrEnDB-Extractor/0.1 (mailto:{mailto})"},
        )
        self._by_name: dict[str, dict[str, Any]] = {}
        self._by_cas: dict[str, dict[str, Any]] = {}
        self._iupac_by_can: dict[str, str] = {}
        self._info_by_can: dict[str, dict[str, Any]] = {}
        self._seed_local_dictionaries(batches_dir=batches_dir, extra_entries=extra_entries)

    def close(self) -> None:
        self._cache.close()
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "Resolver":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _seed_local_dictionaries(
        self,
        *,
        batches_dir: str | Path | None,
        extra_entries: Iterable[dict[str, Any]] | None,
    ) -> None:
        for k, smi in BUILTIN_MOLECULES.items():
            self._by_name[normalize_name_key(k)] = {"smiles": smi, "cas": None, "cls": None, "role": None}

        if batches_dir is not None:
            bdir = Path(batches_dir)
            if bdir.is_dir():
                for fpath in sorted(bdir.glob("batch-*.json")):
                    try:
                        rows = json.loads(fpath.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    self._ingest_known_rows(rows)

        if extra_entries is not None:
            self._ingest_known_rows(extra_entries)

    def _ingest_known_rows(self, rows: Iterable[dict[str, Any]]) -> None:
        for r in rows:
            smi = (r.get("smiles") or "").strip()
            if not smi:
                continue
            name = (r.get("name") or "").strip()
            cas = clean_cas(r.get("cas")) if r.get("cas") else None
            info = {"smiles": smi, "cas": cas if cas_valid(cas) else None, "cls": r.get("cls"), "role": r.get("role")}
            can = self._canonicalize(smi) or smi
            if name and can:
                self._iupac_by_can.setdefault(can, name)
            if can:
                existing = self._info_by_can.get(can)
                if existing is None:
                    self._info_by_can[can] = dict(info)
                else:
                    for k in ("cas", "cls", "role"):
                        if not existing.get(k) and info.get(k):
                            existing[k] = info[k]
            if name:
                nk = normalize_name_key(name)
                if nk:
                    self._by_name.setdefault(nk, info)
                # Also index trailing short alias if present e.g. "(3-MeOTX)"
                m = re.search(r"\(([^()]{2,20})\)\s*$", name)
                if m:
                    alias = normalize_name_key(m.group(1))
                    if alias and not looks_like_anonymous_label(m.group(1)):
                        self._by_name.setdefault(alias, info)
            if info["cas"]:
                self._by_cas.setdefault(info["cas"], info)

    def _canonicalize(self, smiles: str | None) -> str | None:
        if not smiles:
            return None
        s = smiles.strip()
        if not s:
            return None
        if chem.HAS_RDKIT:
            return chem.canonical_smiles(s, isomeric=True)
        return s

    def resolve_opsin(self, name: str) -> str | None:
        if self.offline or not name or looks_like_anonymous_label(name):
            return None
        key = name.strip().lower()
        hit, val = self._cache.get("opsin", key)
        if hit:
            return val
        smiles: str | None = None
        try:
            resp = self._http.get(f"https://opsin.ch.cam.ac.uk/opsin/{quote(name.strip(), safe='')}.json")
            if resp.is_success:
                data = resp.json()
                if data.get("status") == "SUCCESS" and data.get("smiles"):
                    smiles = self._canonicalize(data["smiles"])
            elif resp.status_code not in (400, 404):
                # Rate limit or outage: say nothing now, and ask again next run.
                return None
        except Exception:
            return None
        self._cache.set("opsin", key, smiles)
        return smiles

    def resolve_pubchem_name(self, query: str) -> str | None:
        if self.offline or not query or looks_like_anonymous_label(query):
            return None
        key = query.strip().lower()
        hit, val = self._cache.get("pubchem_name", key)
        if hit:
            return val
        self._pubchem_rl.wait()
        smiles: str | None = None
        try:
            resp = self._http.post(
                "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/property/IsomericSMILES,CanonicalSMILES/JSON",
                data={"name": query.strip()},
            )
            if resp.status_code in (400, 404):
                self._cache.set("pubchem_name", key, None)
                return None
            if resp.is_success:
                props = (resp.json().get("PropertyTable") or {}).get("Properties") or []
                if props:
                    raw = props[0].get("IsomericSMILES") or props[0].get("CanonicalSMILES") or props[0].get("SMILES")
                    smiles = self._canonicalize(raw)
            else:
                return None
        except Exception:
            return None
        self._cache.set("pubchem_name", key, smiles)
        return smiles

    def lookup_cas_from_smiles(self, smiles: str) -> list[str]:
        """Mirror Ent.lookupCas (PubChem synonyms filtered by CAS check-digit)."""
        if self.offline or not smiles:
            return []
        can = self._canonicalize(smiles) or smiles.strip()
        hit, val = self._cache.get("pubchem_cas", can)
        if hit:
            return list(val or [])
        self._pubchem_rl.wait()
        out: list[str] = []
        seen: set[str] = set()
        try:
            resp = self._http.post(
                "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/synonyms/JSON",
                data={"smiles": can},
            )
            if resp.status_code in (400, 404):
                self._cache.set("pubchem_cas", can, [])
                return []
            if not resp.is_success:
                return []
            infos = (resp.json().get("InformationList") or {}).get("Information") or []
            for inf in infos:
                for syn in inf.get("Synonym") or []:
                    c = clean_cas(syn)
                    if cas_valid(c) and c not in seen:
                        seen.add(c)
                        out.append(c)
        except Exception:
            return []
        self._cache.set("pubchem_cas", can, out)
        return out

    def resolve_iupac(self, smiles: str) -> str | None:
        """Return curated local IUPAC name or look up IUPACName on PubChem."""
        if not smiles:
            return None
        can = self._canonicalize(smiles) or smiles.strip()
        if can in self._iupac_by_can:
            return self._iupac_by_can[can]
        if self.offline:
            return None
        hit, val = self._cache.get("pubchem_iupac", can)
        if hit:
            return val
        self._pubchem_rl.wait()
        iupac: str | None = None
        try:
            resp = self._http.post(
                "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/property/IUPACName/JSON",
                data={"smiles": can},
            )
            if resp.status_code in (400, 404):
                self._cache.set("pubchem_iupac", can, None)
                return None
            if resp.is_success:
                props = (resp.json().get("PropertyTable") or {}).get("Properties") or []
                if props and props[0].get("CID") and props[0].get("IUPACName"):
                    iupac = str(props[0]["IUPACName"]).strip() or None
            else:
                return None
        except Exception:
            return None
        self._cache.set("pubchem_iupac", can, iupac)
        return iupac

    def _finish_resolved(
        self,
        smiles: str,
        *,
        cas: str | None,
        source: str,
        cls_hint: str | None = None,
        role_hint: str | None = None,
        lookup_cas: bool = True,
        warnings: list[str] | None = None,
    ) -> ResolvedMolecule:
        known = self._info_by_can.get(smiles) or {}
        found_cas = cas or known.get("cas")
        if not found_cas and lookup_cas:
            cas_list = self.lookup_cas_from_smiles(smiles)
            if cas_list:
                found_cas = cas_list[0]
        return ResolvedMolecule(
            smiles=smiles,
            cas=found_cas,
            source=source,
            cls_hint=cls_hint or known.get("cls"),
            role_hint=role_hint or known.get("role"),
            iupac_name=self._iupac_by_can.get(smiles),
            warnings=list(warnings or []),
        )

    def doi_resolves(self, doi: str) -> bool | None:
        d = clean_doi(doi)
        if not is_doi(d):
            return False
        if self.offline:
            return None
        hit, val = self._cache.get("doi_resolves", d.lower())
        if hit:
            return val
        try:
            resp = self._http.get(f"https://doi.org/api/handles/{quote(d, safe='')}")
            if resp.status_code == 404:
                self._cache.set("doi_resolves", d.lower(), False)
                return False
            if not resp.is_success:
                return None
            ok = resp.json().get("responseCode") == 1
            self._cache.set("doi_resolves", d.lower(), ok)
            return ok
        except Exception:
            return None

    def fetch_citation(self, doi: str) -> str | None:
        """Query Crossref Works API and format 'Authors, Journal Year, Vol, Pages'."""
        d = clean_doi(doi)
        if not is_doi(d) or self.offline:
            return None
        hit, val = self._cache.get("crossref_cite", d.lower())
        if hit:
            return val
        try:
            resp = self._http.get(f"https://api.crossref.org/works/{quote(d, safe='')}")
            if not resp.is_success:
                return None
            msg = resp.json().get("message") or {}
            cite = format_crossref_citation(msg)
        except Exception:
            return None
        self._cache.set("crossref_cite", d.lower(), cite)
        return cite

    def resolve_molecule(
        self,
        name: str,
        *,
        cas: str | None = None,
        raw_smiles: str | None = None,
        lookup_cas: bool = True,
    ) -> ResolvedMolecule:
        warnings: list[str] = []
        clean_c = clean_cas(cas) if cas else None
        if clean_c and not cas_valid(clean_c):
            warnings.append(f"Invalid CAS check digit ignored: {cas}")
            clean_c = None

        # 1. Explicit SMILES
        if raw_smiles:
            can = self._canonicalize(raw_smiles)
            if can:
                return self._finish_resolved(can, cas=clean_c, source="explicit_smiles", lookup_cas=lookup_cas, warnings=warnings)
            warnings.append(f"Explicit SMILES failed validation: {raw_smiles}")

        # 2. Local dictionary by CAS
        if clean_c and clean_c in self._by_cas:
            info = self._by_cas[clean_c]
            can = self._canonicalize(info["smiles"])
            if can:
                return self._finish_resolved(
                    can,
                    cas=clean_c,
                    source="local_cas",
                    cls_hint=info.get("cls"),
                    role_hint=info.get("role"),
                    lookup_cas=False,
                    warnings=warnings,
                )

        # 3. Local dictionary by normalized name
        nk = normalize_name_key(name)
        if nk and nk in self._by_name:
            info = self._by_name[nk]
            can = self._canonicalize(info["smiles"])
            if can:
                return self._finish_resolved(
                    can,
                    cas=clean_c or info.get("cas"),
                    source="local_dict",
                    cls_hint=info.get("cls"),
                    role_hint=info.get("role"),
                    lookup_cas=lookup_cas,
                    warnings=warnings,
                )

        # 4. PubChem by CAS if provided
        if clean_c:
            smi = self.resolve_pubchem_name(clean_c)
            if smi:
                return self._finish_resolved(smi, cas=clean_c, source="pubchem_cas", lookup_cas=False, warnings=warnings)

        # 5. OPSIN (IUPAC) and PubChem (common/trivial names)
        candidates = [name.strip()]
        stripped = _TRAILING_LABEL_RE.sub("", name.strip()).strip()
        if stripped and stripped != name.strip():
            candidates.append(stripped)

        for cand in candidates:
            if not cand or looks_like_anonymous_label(cand):
                continue
            smi = self.resolve_opsin(cand)
            src = "opsin"
            if not smi:
                smi = self.resolve_pubchem_name(cand)
                src = "pubchem_name"
            if smi:
                return self._finish_resolved(smi, cas=clean_c, source=src, lookup_cas=lookup_cas, warnings=warnings)

        if looks_like_anonymous_label(name):
            warnings.append(f"Name '{name}' looks like a paper-local label; structure cannot be resolved without scheme.")
        else:
            warnings.append(f"Could not resolve SMILES for '{name}' via local dict, OPSIN, or PubChem.")
        return ResolvedMolecule(smiles=None, cas=clean_c, source="unresolved", warnings=warnings)


def format_crossref_citation(msg: dict[str, Any]) -> str | None:
    authors = []
    for a in msg.get("author") or []:
        fam = a.get("family")
        if fam:
            authors.append(fam)
    if len(authors) > 6:
        author_str = f"{authors[0]} et al."
    else:
        author_str = ", ".join(authors)

    journal_list = msg.get("short-container-title") or msg.get("container-title") or []
    journal = journal_list[0] if journal_list else ""

    year = ""
    for date_key in ("published-print", "published-online", "issued", "created"):
        parts = ((msg.get(date_key) or {}).get("date-parts") or [[]])[0]
        if parts and parts[0]:
            year = str(parts[0])
            break

    vol = str(msg.get("volume") or "")
    page = str(msg.get("page") or msg.get("article-number") or "").replace("-", "–")

    parts = [p for p in [author_str, f"{journal} {year}".strip(), vol, page] if p]
    return ", ".join(parts) if parts else None
