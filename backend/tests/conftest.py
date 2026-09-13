"""Shared fixtures.

Every test runs against a scrubbed environment: the settings layer reads the
same environment variables the TypeScript server does (NETPRO_HOST, PORT,
DB_DIALECT, …), so any of those leaking into the test process would make
results machine-dependent. The autouse fixture deletes them; individual
tests re-set exactly the ones they exercise via ``monkeypatch``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from netpro.api import create_app
from netpro.config import Settings

#: Every environment variable Settings() reads (see netpro/config/settings.py).
SETTINGS_ENV_VARS = (
    "NETPRO_HOME",
    "NETPRO_HOST",
    "HOST",
    "NETPRO_PORT",
    "PORT",
    "NETPRO_AUTH_MODE",
    "NETPRO_AUTO_MIGRATE",
    "DB_DIALECT",
    "NETPRO_LOG_LEVEL",
)


@pytest.fixture(autouse=True)
def clean_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove NetPro-relevant env vars so defaults are deterministic."""
    for var in SETTINGS_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Isolated settings: temp install dir, quiet logs."""
    return Settings(home=tmp_path / "netpro-home", log_level="WARNING")


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """TestClient bound to an app with the isolated settings."""
    with TestClient(create_app(settings)) as test_client:
        yield test_client
