"""Settings: environment → `config.toml` → defaults, resolved once.

Precedence (highest wins) matches the TypeScript product exactly:

1. explicit environment variables (`NETPRO_*`, `HOST`, `PORT`, `DB_*`, `DATABASE_URL`)
2. `~/.netpro/config.toml`
3. built-in defaults (SQLite at `<home>/netpro.db`, `127.0.0.1:3777`, auth mode `local`)

A fresh machine therefore needs no environment at all — that is the point of
local-first. An invalid `config.toml` is a loud `LocalConfigError`, never a
silently ignored file: a typo in `[server] port` must stop the process rather
than strand the operator on a port they believe they changed.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from netpro.config.paths import (
    config_toml_path,
    default_sqlite_path,
    expand_home_path,
    netpro_home,
    resolve_sqlite_path,
)
from netpro.config.toml_subset import TomlSubsetError, TomlTable, parse_toml
from netpro.domain.errors import LocalConfigError

__all__ = [
    "AUTH_MODES",
    "DEFAULT_AUTH_MODE",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DIALECT_ALIASES",
    "AuthMode",
    "AuthSettings",
    "DatabaseSettings",
    "DbDialect",
    "InstallationSettings",
    "LocalConfig",
    "ServerSettings",
    "Settings",
    "load_settings",
    "parse_auth_mode",
    "parse_dialect",
    "read_local_config",
]

#: Bind address. Remote exposure must always be explicit.
DEFAULT_HOST = "127.0.0.1"

#: Default TCP port.
DEFAULT_PORT = 3777

DbDialect = Literal["sqlite", "postgresql"]
AuthMode = Literal["local", "token", "open"]

#: The three authentication modes, in the order the docs list them.
AUTH_MODES: tuple[AuthMode, ...] = ("local", "token", "open")

DEFAULT_AUTH_MODE: AuthMode = "local"

#: Accepted spellings of a dialect, normalised to the canonical value.
DIALECT_ALIASES: dict[str, DbDialect] = {
    "sqlite": "sqlite",
    "postgres": "postgresql",
    "postgresql": "postgresql",
}

EnvMapping = Mapping[str, str]


def parse_dialect(value: str, origin: str) -> DbDialect:
    """Normalise a dialect string. Unknown values are a loud error."""
    dialect = DIALECT_ALIASES.get(value.strip().lower())
    if dialect is None:
        msg = f'Unknown database dialect "{value}" in {origin}. Expected "sqlite" or "postgresql".'
        raise LocalConfigError(msg)
    return dialect


def parse_auth_mode(value: str, origin: str) -> AuthMode:
    """Validate an auth mode. A typo must not decide which security policy runs."""
    normalized = value.strip().lower()
    if normalized in AUTH_MODES:
        return normalized
    msg = f'Unknown auth mode "{value}" in {origin}. Expected "local", "token", or "open".'
    raise LocalConfigError(msg)


class DatabaseSettings(BaseModel):
    """Which database this process talks to."""

    model_config = ConfigDict(frozen=True)

    dialect: DbDialect = "sqlite"
    #: Absolute SQLite path (dialect `sqlite`).
    path: Path | None = None
    #: PostgreSQL connection string (dialect `postgresql`).
    url: str | None = None
    #: Where the dialect decision came from: `env`, `config`, or `default`.
    source: Literal["env", "config", "default"] = "default"


class ServerSettings(BaseModel):
    """HTTP bind settings for `netpro serve`."""

    model_config = ConfigDict(frozen=True)

    host: str = DEFAULT_HOST
    port: int = Field(default=DEFAULT_PORT, ge=1, le=65535)
    #: Explicit CORS allow-list. `None` selects the loopback-only default.
    allowed_origins: tuple[str, ...] | None = None
    #: Where the separate Next.js UI runs (banner display only).
    web_url: str | None = None
    auto_migrate: bool = True
    #: Send HSTS. Opt-in, and only meaningful behind a TLS-terminating proxy.
    hsts: bool = False

    @property
    def is_loopback_bind(self) -> bool:
        """True when the bind address is a loopback address."""
        host = self.host.strip().lower().strip("[]")
        return host in {"localhost", "::1"} or host.startswith("127.")


class AuthSettings(BaseModel):
    """Authentication mode for the local server."""

    model_config = ConfigDict(frozen=True)

    mode: AuthMode = DEFAULT_AUTH_MODE


class InstallationSettings(BaseModel):
    """The local installation identity from `[installation]`."""

    model_config = ConfigDict(frozen=True)

    id: str | None = None
    created_at: str | None = None
    owner: str | None = None
    email: str | None = None


class LocalConfig(BaseModel):
    """The validated contents of `~/.netpro/config.toml`."""

    model_config = ConfigDict(frozen=True)

    path: Path
    database: dict[str, Any] | None = None
    server: dict[str, Any] | None = None
    installation: InstallationSettings | None = None
    auth: AuthSettings | None = None
    raw: TomlTable = Field(default_factory=dict)


class Settings(BaseModel):
    """Fully resolved settings for one process."""

    model_config = ConfigDict(frozen=True)

    home: Path
    config_path: Path
    database: DatabaseSettings
    server: ServerSettings
    auth: AuthSettings
    installation: InstallationSettings
    raw: TomlTable = Field(default_factory=dict)

    @property
    def logs_dir(self) -> Path:
        """`<home>/logs`."""
        return self.home / "logs"

    @property
    def keys_dir(self) -> Path:
        """`<home>/keys`."""
        return self.home / "keys"

    @property
    def access_token_path(self) -> Path:
        """`<home>/keys/access-token`."""
        return self.keys_dir / "access-token"

    def describe_database(self) -> str:
        """Where the data lives, safe to print (no credentials)."""
        if self.database.dialect == "sqlite":
            path = self.database.path or default_sqlite_path()
            return f"sqlite {path}"
        return f"postgresql {_redact_url(self.database.url or '')}"

    def to_public_dict(self) -> dict[str, Any]:
        """The subset of settings the API may expose (`GET /api/settings`).

        Paths and modes only — never a token, never a URL with credentials.
        """
        return {
            "home": str(self.home),
            "configPath": str(self.config_path),
            "database": {
                "dialect": self.database.dialect,
                "path": str(self.database.path) if self.database.path else None,
                "source": self.database.source,
            },
            "server": {
                "host": self.server.host,
                "port": self.server.port,
                "hsts": self.server.hsts,
            },
            "auth": {"mode": self.auth.mode},
            "installation": {"id": self.installation.id},
        }


def load_settings(env: EnvMapping | None = None) -> Settings:
    """Resolve settings from environment + `~/.netpro/config.toml`.

    Recognised environment variables:

    - `NETPRO_HOME` — relocate the install directory
    - `NETPRO_HOST` / `HOST` — bind address (default `127.0.0.1`)
    - `NETPRO_PORT` / `PORT` — TCP port (default `3777`)
    - `NETPRO_AUTH_MODE` — `local` (default) | `token` | `open`
    - `NETPRO_ALLOWED_ORIGINS` — CSV CORS allow-list (default: loopback only)
    - `NETPRO_HSTS` — send Strict-Transport-Security (behind TLS only)
    - `NETPRO_WEB_URL` — where the separate Web UI runs (display only)
    - `NETPRO_AUTO_MIGRATE` — apply pending migrations on startup
    - `DB_DIALECT` / `DB_PATH` / `DATABASE_URL` — database selection

    No cloud-platform, `AUTH_URL`, or GitHub OAuth variables are required.
    """
    mapping: EnvMapping = os.environ if env is None else env
    file = read_local_config(mapping)

    home = netpro_home(mapping)
    database = _resolve_database(mapping, file, home)
    server = _resolve_server(mapping, file)
    auth = _resolve_auth(mapping, file)

    return Settings(
        home=home,
        config_path=file.path,
        database=database,
        server=server,
        auth=auth,
        installation=file.installation or InstallationSettings(),
        raw=file.raw,
    )


# ── config.toml ────────────────────────────────────────────────────────────

_KNOWN_SECTIONS = ("database", "server", "installation", "auth")
_KNOWN_SERVER_KEYS = ("host", "port", "allowed_origins", "web_url")
_KNOWN_INSTALLATION_KEYS = ("id", "created_at", "owner", "email")


def read_local_config(env: EnvMapping | None = None) -> LocalConfig:
    """Read and validate `<home>/config.toml`. A missing file means "defaults".

    Unknown sections and unknown keys are errors, not warnings — except inside
    `[database]`, which the TypeScript reader also leaves permissive. That
    asymmetry is preserved deliberately so both implementations accept exactly
    the same files (`packages/db/src/local.ts`).
    """
    mapping: EnvMapping = os.environ if env is None else env
    path = config_toml_path(mapping)
    if not path.exists():
        return LocalConfig(path=path)

    try:
        table = parse_toml(path.read_text(encoding="utf-8"))
    except TomlSubsetError as error:
        raise LocalConfigError(f"{path}: {error}") from error
    except OSError as error:
        raise LocalConfigError(f"{path}: {error.strerror or error}") from error

    for section in table:
        if section not in _KNOWN_SECTIONS:
            raise LocalConfigError(
                f"{path}: unknown section [{section}] "
                "(NetPro understands [database], [server], [installation], and [auth])"
            )

    database = _read_database_section(table, path)
    server = _read_server_section(table, path)
    installation = _read_installation_section(table, path)
    auth = _read_auth_section(table, path)

    return LocalConfig(
        path=path,
        database=database,
        server=server,
        installation=installation,
        auth=auth,
        raw=table,
    )


def _read_database_section(table: TomlTable, path: Path) -> dict[str, Any] | None:
    section = _expect_table(table, "database", path)
    if section is None:
        return None
    values: dict[str, Any] = {}
    for key in ("dialect", "path", "url"):
        value = _expect_string(section, "database", key)
        if value is not None:
            values[key] = value
    return values or None


def _read_server_section(table: TomlTable, path: Path) -> dict[str, Any] | None:
    section = _expect_table(table, "server", path)
    if section is None:
        return None
    for key in section:
        if key not in _KNOWN_SERVER_KEYS:
            raise LocalConfigError(
                f'{path}: unknown key "{key}" in [server] '
                "(NetPro understands host, port, allowed_origins, web_url)"
            )

    values: dict[str, Any] = {}
    host = _expect_string(section, "server", "host")
    if host is not None:
        values["host"] = host

    port = section.get("port")
    if port is not None:
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise LocalConfigError(f"{path}: [server] port must be an integer between 1 and 65535")
        values["port"] = port

    for key in ("allowed_origins", "web_url"):
        value = _expect_string(section, "server", key)
        if value is not None:
            values[key] = value

    return values or None


def _read_installation_section(table: TomlTable, path: Path) -> InstallationSettings | None:
    section = _expect_table(table, "installation", path)
    if section is None:
        return None
    for key in section:
        if key not in _KNOWN_INSTALLATION_KEYS:
            raise LocalConfigError(
                f'{path}: unknown key "{key}" in [installation] '
                "(NetPro understands id, created_at, owner, email)"
            )

    values: dict[str, str] = {}
    for key in _KNOWN_INSTALLATION_KEYS:
        value = _expect_string(section, "installation", key)
        if value is not None:
            values[key] = value

    installation_id = values.get("id")
    if installation_id is not None and len(installation_id) > 200:
        raise LocalConfigError(f"{path}: [installation] id is too long (max 200 characters)")

    return InstallationSettings(**values) if values else None


def _read_auth_section(table: TomlTable, path: Path) -> AuthSettings | None:
    section = _expect_table(table, "auth", path)
    if section is None:
        return None
    for key in section:
        if key != "mode":
            raise LocalConfigError(
                f'{path}: unknown key "{key}" in [auth] (NetPro understands mode)'
            )

    mode = _expect_string(section, "auth", "mode")
    if mode is None:
        return None
    if mode not in AUTH_MODES:
        raise LocalConfigError(
            f'{path}: [auth] mode must be "local", "token", or "open" (got "{mode}")'
        )
    return AuthSettings(mode=mode)


def _expect_table(table: TomlTable, name: str, path: Path) -> dict[str, Any] | None:
    value = table.get(name)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise LocalConfigError(f"{path}: [{name}] must be a table")
    return dict(value)


def _expect_string(section: Mapping[str, Any], name: str, key: str) -> str | None:
    """Read a required-shape string. Message matches the TypeScript reader."""
    value = section.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise LocalConfigError(f"config.toml [{name}] {key} must be a non-empty string")
    return value.strip()


# ── resolution ─────────────────────────────────────────────────────────────


def _resolve_database(env: EnvMapping, file: LocalConfig, home: Path) -> DatabaseSettings:
    file_db = file.database or {}

    env_dialect = (env.get("DB_DIALECT") or "").strip()
    if env_dialect:
        dialect = parse_dialect(env_dialect, "DB_DIALECT")
        source: Literal["env", "config", "default"] = "env"
    elif isinstance(file_db.get("dialect"), str):
        dialect = parse_dialect(file_db["dialect"], str(file.path))
        source = "config"
    else:
        # No hosted-platform inference: a set DATABASE_URL alone never flips the
        # dialect. SQLite is the local default; PostgreSQL is always explicit.
        dialect = "sqlite"
        source = "default"

    if dialect == "sqlite":
        env_path = (env.get("DB_PATH") or "").strip()
        file_path = file_db.get("path")
        if env_path:
            path = Path(expand_home_path(env_path, env))
        elif isinstance(file_path, str):
            path = resolve_sqlite_path(file_path, env)
        else:
            path = default_sqlite_path(env)
        return DatabaseSettings(dialect=dialect, path=path, url=None, source=source)

    url = (env.get("DATABASE_URL") or "").strip()
    if not url and isinstance(file_db.get("url"), str):
        url = file_db["url"].strip()
    if not url:
        raise LocalConfigError(
            'DATABASE_URL is required when the database dialect is "postgresql". '
            'Set DATABASE_URL, or add url = "postgresql://…" to [database] in '
            f"{file.path}. (For local single-user use, the default SQLite dialect "
            "needs no URL at all.)"
        )
    return DatabaseSettings(dialect=dialect, path=None, url=url, source=source)


def _resolve_server(env: EnvMapping, file: LocalConfig) -> ServerSettings:
    file_server = file.server or {}

    host = (env.get("NETPRO_HOST") or env.get("HOST") or "").strip()
    if not host and isinstance(file_server.get("host"), str):
        host = file_server["host"]
    host = host or DEFAULT_HOST

    raw_port = (env.get("NETPRO_PORT") or env.get("PORT") or "").strip()
    port = _positive_port(raw_port, int(file_server.get("port", DEFAULT_PORT)))

    allowed_origins = _parse_origins(env.get("NETPRO_ALLOWED_ORIGINS"))
    if allowed_origins is None and isinstance(file_server.get("allowed_origins"), str):
        allowed_origins = _parse_origins(file_server["allowed_origins"])

    web_url = (env.get("NETPRO_WEB_URL") or "").strip()
    if not web_url and isinstance(file_server.get("web_url"), str):
        web_url = file_server["web_url"].strip()

    return ServerSettings(
        host=host,
        port=port,
        allowed_origins=allowed_origins,
        web_url=web_url or None,
        auto_migrate=_flag(env.get("NETPRO_AUTO_MIGRATE"), default=True),
        hsts=_flag(env.get("NETPRO_HSTS"), default=False),
    )


def _resolve_auth(env: EnvMapping, file: LocalConfig) -> AuthSettings:
    raw = (env.get("NETPRO_AUTH_MODE") or "").strip()
    if raw:
        return AuthSettings(mode=parse_auth_mode(raw, "NETPRO_AUTH_MODE"))
    if file.auth is not None:
        return file.auth
    return AuthSettings()


def _positive_port(value: str, fallback: int) -> int:
    """An operator override that does not parse falls back, like the TS helper."""
    if not value:
        return fallback
    try:
        parsed = float(value)
    except ValueError:
        return fallback
    if not math.isfinite(parsed) or parsed <= 0 or parsed > 65535:
        return fallback
    return int(parsed)


def _flag(raw: str | None, *, default: bool) -> bool:
    """`0/false/no/off` are false; anything else set is true (matches TS)."""
    if raw is None:
        return default
    text = raw.strip()
    if not text:
        return default
    return text.lower() not in {"0", "false", "no", "off"}


def _parse_origins(raw: str | None) -> tuple[str, ...] | None:
    """Parse a comma-separated origin list. Empty/unset means "no explicit list"."""
    if raw is None or not raw.strip():
        return None
    origins = tuple(entry.strip() for entry in raw.split(",") if entry.strip())
    return origins or None


def _redact_url(url: str) -> str:
    """Hide credentials in a connection string before it is printed or logged."""
    if "@" not in url or "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    credentials, _, host_part = rest.partition("@")
    user = credentials.split(":", 1)[0]
    return f"{scheme}://{user}:***@{host_part}"
