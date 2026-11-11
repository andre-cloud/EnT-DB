"""Public read-only client for TrEnDB (Supabase RPC list_entries + offline batches)."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from .config import TrEnDBConfig, load_config
from .models import Entry, MoleculeGroup
from .query import QueryBuilder, SearchResult, filter_entries, group_by_molecule

PAGE_SIZE = 1000


class TrEnDBError(RuntimeError):
    """Raised when TrEnDB API requests fail or return unexpected payloads."""


class TrEnDBClient:
    """Read-only client for the public TrEnDB database (approved entries only).

    Connects to Supabase ``POST /rest/v1/rpc/list_entries`` with automatic 1000-row
    pagination and supports optional ``site_access`` shared login credentials, file
    caching with TTL, or offline querying against ``docs/batches/*.json``.
    """

    def __init__(
        self,
        *,
        supabase_url: str | None = None,
        supabase_anon_key: str | None = None,
        site_user: str | None = None,
        site_pass: str | None = None,
        repo_root: str | Path | None = None,
        cache_path: str | Path | None = None,
        cache_ttl_seconds: float = 0.0,
        timeout: float = 20.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.config: TrEnDBConfig = load_config(
            supabase_url=supabase_url,
            supabase_anon_key=supabase_anon_key,
            site_user=site_user,
            site_pass=site_pass,
            repo_root=repo_root,
        )
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)
        self._cache_path = Path(cache_path) if cache_path else None
        self._cache_ttl = float(cache_ttl_seconds)
        self._memory_cache: tuple[float, list[Entry]] | None = None
        self._offline_entries: list[Entry] | None = None

    @classmethod
    def from_batches(cls, batches_dir: str | Path = "docs/batches") -> "TrEnDBClient":
        """Create an offline client reading local batch JSON files."""
        bdir = Path(batches_dir)
        idx_file = bdir / "index.json"
        if idx_file.is_file():
            files = [bdir / name for name in json.loads(idx_file.read_text(encoding="utf-8")).get("files", [])]
        else:
            files = sorted(bdir.glob("batch-*.json"))

        rows: list[Entry] = []
        for fpath in files:
            if not fpath.is_file():
                continue
            for item in json.loads(fpath.read_text(encoding="utf-8")):
                rows.append(Entry.from_dict(item))

        inst = cls(supabase_url="", supabase_anon_key="")
        inst._offline_entries = rows
        return inst

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "TrEnDBClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _headers(self) -> dict[str, str]:
        key = self.config.supabase_anon_key
        h = {"apikey": key, "Content-Type": "application/json"}
        # Mirror docs/assets/common.js: sb_* publishable keys are not JWTs.
        if key and not key.startswith("sb_"):
            h["Authorization"] = f"Bearer {key}"
        return h

    def _creds_payload(self) -> dict[str, str]:
        return {"p_user": self.config.site_user, "p_pass": self.config.site_pass}

    def _require_configured(self) -> None:
        if not self.config.is_configured:
            raise TrEnDBError(
                "TrEnDB Supabase URL / anon key are not configured. "
                "Pass them explicitly, set TRENDB_URL / TRENDB_ANON_KEY, or run inside the repository."
            )

    def check_access(self) -> bool:
        """Return True if the public database is open or shared-site credentials match."""
        if self._offline_entries is not None:
            return True
        self._require_configured()
        resp = self._http.post(
            f"{self.config.supabase_url}/rest/v1/rpc/check_access",
            headers=self._headers(),
            json=self._creds_payload(),
        )
        if not resp.is_success:
            raise TrEnDBError(f"check_access failed ({resp.status_code}): {resp.text}")
        return bool(resp.json())

    def _read_disk_cache(self) -> list[Entry] | None:
        if not self._cache_path or not self._cache_path.is_file() or self._cache_ttl <= 0:
            return None
        try:
            payload = json.loads(self._cache_path.read_text(encoding="utf-8"))
            age = time.time() - float(payload.get("fetched_at", 0))
            if age <= self._cache_ttl:
                return [Entry.from_dict(r) for r in payload.get("entries", [])]
        except Exception:
            return None
        return None

    def _write_disk_cache(self, entries: list[Entry]) -> None:
        if not self._cache_path or self._cache_ttl <= 0:
            return
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"fetched_at": time.time(), "entries": [e.to_dict() for e in entries]}
        self._cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def fetch_entries(self, *, force_refresh: bool = False) -> list[Entry]:
        """Fetch all approved entries from public.list_entries (paginated by 1000)."""
        if self._offline_entries is not None:
            return list(self._offline_entries)

        if not force_refresh:
            if self._memory_cache is not None:
                ts, cached = self._memory_cache
                if self._cache_ttl <= 0 or (time.time() - ts) <= self._cache_ttl:
                    return list(cached)
            disk = self._read_disk_cache()
            if disk is not None:
                self._memory_cache = (time.time(), disk)
                return list(disk)

        self._require_configured()
        entries: list[Entry] = []
        offset = 0
        while True:
            url = (
                f"{self.config.supabase_url}/rest/v1/rpc/list_entries"
                f"?order=created_at.asc,id.asc&limit={PAGE_SIZE}&offset={offset}"
            )
            resp = self._http.post(url, headers=self._headers(), json=self._creds_payload())
            if resp.status_code == 401:
                raise TrEnDBError("Access denied (401): check site_user / site_pass or anon key.")
            if not resp.is_success:
                raise TrEnDBError(f"list_entries failed ({resp.status_code}): {resp.text}")
            rows = resp.json() or []
            entries.extend(Entry.from_dict(r) for r in rows)
            if len(rows) < PAGE_SIZE:
                break
            offset += PAGE_SIZE

        if not entries and not self.check_access():
            raise TrEnDBError(
                "Public database is gated by site_access (private preview) and credentials were missing or rejected. "
                "Pass site_user=... and site_pass=... to TrEnDBClient(...), set TRENDB_USER / TRENDB_PASS "
                "(or add them to .env), or use TrEnDBClient.from_batches('docs/batches') for offline batch data."
            )

        self._memory_cache = (time.time(), entries)
        self._write_disk_cache(entries)
        return list(entries)

    def query(self) -> QueryBuilder:
        """Start a chainable query against the database."""
        return QueryBuilder(self)

    def search(self, **filters: Any) -> SearchResult:
        """Filter approved entries directly (accepts all filter_entries arguments)."""
        return filter_entries(self.fetch_entries(), **filters)

    def group_by_molecule(self, **filters: Any) -> list[MoleculeGroup]:
        """Fetch (and optionally filter) entries, grouped one MoleculeGroup per molecule."""
        res = self.search(**filters) if filters else SearchResult(self.fetch_entries())
        return group_by_molecule(res.entries)

    def stats(self, *, top_n: int = 10, **filters: Any) -> Any:
        """Compute descriptive, completeness, and exp-vs-calc statistics on entries."""
        res = self.search(**filters) if filters else SearchResult(self.fetch_entries())
        return res.stats(top_n=top_n)

    def exp_vs_calc(self, **filters: Any) -> Any:
        """Benchmark computed vs experimental E_T across molecules with both origins."""
        res = self.search(**filters) if filters else SearchResult(self.fetch_entries())
        return res.exp_vs_calc()

    def molecule_spread(self, *, origin: str | None = None, min_count: int = 2, **filters: Any) -> list[Any]:
        """List molecules with multiple entries and their E_T span/std."""
        res = self.search(**filters) if filters else SearchResult(self.fetch_entries())
        return res.molecule_spread(origin=origin, min_count=min_count)

    def descriptors(self, **filters: Any) -> list[dict[str, Any]]:
        """Compute RDKit physicochemical descriptors alongside E_T for matched entries."""
        res = self.search(**filters) if filters else SearchResult(self.fetch_entries())
        return res.descriptors()
