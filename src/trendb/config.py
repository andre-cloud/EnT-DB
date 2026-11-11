"""Configuration discovery for TrEnDB (reads docs/assets/config.js or env vars)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

_URL_RE = re.compile(r'supabaseUrl\s*:\s*["\']([^"\']*)["\']')
_KEY_RE = re.compile(r'supabaseAnonKey\s*:\s*["\']([^"\']*)["\']')
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT_RE = re.compile(r"(?:^|(?<=\s))//[^\n]*", re.MULTILINE)


@dataclass(frozen=True)
class TrEnDBConfig:
    """Public Supabase connection settings and optional shared-site or curator credentials."""

    supabase_url: str
    supabase_anon_key: str
    site_user: str = ""
    site_pass: str = ""
    curator_email: str = ""
    curator_pass: str = ""
    repo_root: Path | None = None

    @property
    def is_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)


def find_repo_root(start: str | Path | None = None) -> Path | None:
    """Locate the EnT-DB / TrEnDB repository root containing docs/assets/config.js."""
    cur = Path(start or Path.cwd()).resolve()
    if cur.is_file():
        cur = cur.parent
    for candidate in (cur, *cur.parents):
        if (candidate / "docs" / "assets" / "config.js").is_file():
            return candidate
    # Fallback relative to this source file when imported from editable install.
    src_root = Path(__file__).resolve().parents[2]
    if (src_root / "docs" / "assets" / "config.js").is_file():
        return src_root
    return None


def parse_config_js(path: str | Path) -> tuple[str, str]:
    """Extract (supabaseUrl, supabaseAnonKey) from docs/assets/config.js."""
    text = Path(path).read_text(encoding="utf-8")
    cleaned = _BLOCK_COMMENT_RE.sub("", text)
    cleaned = _LINE_COMMENT_RE.sub("", cleaned)
    url_m = _URL_RE.search(cleaned)
    key_m = _KEY_RE.search(cleaned)
    url = url_m.group(1).strip().rstrip("/") if url_m else ""
    key = key_m.group(1).strip() if key_m else ""
    return url, key


def _read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        if k:
            out[k] = v
    return out


def load_config(
    *,
    supabase_url: str | None = None,
    supabase_anon_key: str | None = None,
    site_user: str | None = None,
    site_pass: str | None = None,
    curator_email: str | None = None,
    curator_pass: str | None = None,
    repo_root: str | Path | None = None,
) -> TrEnDBConfig:
    """Resolve TrEnDB configuration from explicit args, env vars, .env, or docs/assets/config.js."""
    root = Path(repo_root).resolve() if repo_root else find_repo_root()
    js_url, js_key = ("", "")
    dotenv: dict[str, str] = {}
    if root is not None:
        cfg_file = root / "docs" / "assets" / "config.js"
        if cfg_file.is_file():
            js_url, js_key = parse_config_js(cfg_file)
        dotenv = _read_dotenv(root / ".env")
    if not dotenv and (Path.cwd() / ".env").is_file():
        dotenv = _read_dotenv(Path.cwd() / ".env")

    url = (supabase_url or os.getenv("TRENDB_URL") or dotenv.get("TRENDB_URL") or js_url or "").strip().rstrip("/")
    key = (supabase_anon_key or os.getenv("TRENDB_ANON_KEY") or dotenv.get("TRENDB_ANON_KEY") or js_key or "").strip()
    user = site_user if site_user is not None else (os.getenv("TRENDB_USER") or dotenv.get("TRENDB_USER") or "")
    passwd = site_pass if site_pass is not None else (os.getenv("TRENDB_PASS") or dotenv.get("TRENDB_PASS") or "")
    c_email = (
        curator_email
        if curator_email is not None
        else (os.getenv("TRENDB_CURATOR_EMAIL") or dotenv.get("TRENDB_CURATOR_EMAIL") or "")
    )
    c_pass = (
        curator_pass
        if curator_pass is not None
        else (os.getenv("TRENDB_CURATOR_PASS") or dotenv.get("TRENDB_CURATOR_PASS") or "")
    )
    return TrEnDBConfig(
        supabase_url=url,
        supabase_anon_key=key,
        site_user=user,
        site_pass=passwd,
        curator_email=c_email,
        curator_pass=c_pass,
        repo_root=root,
    )
