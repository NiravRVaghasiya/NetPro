"""Shared fixtures.

Everything is hermetic: the install directory is a `tmp_path`, the environment
is an explicit mapping (never `os.environ`), the API is exercised in-process
through `httpx.ASGITransport`, and no test touches the network or a database.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from netpro.api import build_container, create_app
from netpro.config import Settings, load_settings

#: `backend/tests/conftest.py` → repo root, where the Phase 0 fixtures live.
REPO_ROOT = Path(__file__).resolve().parents[2]

#: Frozen TypeScript behaviour captured during Phase 0.
FIXTURES_DIR = REPO_ROOT / "docs" / "python-migration" / "fixtures"


@pytest.fixture
def repo_root() -> Path:
    """The repository root, for tests that read the TypeScript source."""
    return REPO_ROOT


@pytest.fixture
def netpro_home(tmp_path: Path) -> Path:
    """An empty install directory, exported as `NETPRO_HOME`."""
    home = tmp_path / "netpro-home"
    home.mkdir()
    return home


@pytest.fixture
def env(netpro_home: Path) -> dict[str, str]:
    """An explicit environment mapping. Never `os.environ`."""
    return {"HOME": str(netpro_home.parent), "NETPRO_HOME": str(netpro_home)}


@pytest.fixture
def settings(env: Mapping[str, str]) -> Settings:
    """Default settings for a fresh install (SQLite, local auth, loopback)."""
    return load_settings(env)


@pytest.fixture
def api(settings: Settings) -> FastAPI:
    """The real application, with a container bound to the temp install."""
    return create_app(build_container(settings, version="0.0.0-test"))


@pytest.fixture
async def client(api: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """An HTTP client wired straight into the ASGI app (loopback peer)."""
    transport = httpx.ASGITransport(app=api)
    async with httpx.AsyncClient(transport=transport, base_url="http://netpro.test") as http:
        yield http


@pytest.fixture
def remote_client(api: FastAPI) -> Callable[..., httpx.AsyncClient]:
    """Build a client whose peer address is **not** loopback."""

    def build(**kwargs: Any) -> httpx.AsyncClient:
        transport = httpx.ASGITransport(app=api, client=("203.0.113.9", 5555))
        return httpx.AsyncClient(transport=transport, base_url="http://netpro.test", **kwargs)

    return build


@pytest.fixture
def load_fixture() -> Callable[[str], Any]:
    """Read a Phase 0 fixture file (`api/health.json`, ...)."""

    def load(relative: str) -> Any:
        path = FIXTURES_DIR / relative
        if path.suffix == ".json":
            return json.loads(path.read_text(encoding="utf-8"))
        return path.read_text(encoding="utf-8")

    return load


@pytest.fixture
def write_config(netpro_home: Path) -> Callable[[str], Path]:
    """Write `<home>/config.toml` and return its path."""

    def write(text: str) -> Path:
        path = netpro_home / "config.toml"
        path.write_text(text, encoding="utf-8")
        return path

    return write


@pytest.fixture(autouse=True)
def _no_stray_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the ambient environment out of settings resolution in tests."""
    for variable in (
        "NETPRO_HOME",
        "NETPRO_HOST",
        "NETPRO_PORT",
        "HOST",
        "PORT",
        "NETPRO_AUTH_MODE",
        "NETPRO_ALLOWED_ORIGINS",
        "NETPRO_HSTS",
        "NETPRO_WEB_URL",
        "NETPRO_AUTO_MIGRATE",
        "DB_DIALECT",
        "DB_PATH",
        "DATABASE_URL",
    ):
        monkeypatch.delenv(variable, raising=False)
