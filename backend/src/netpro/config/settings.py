"""Environment-backed settings, compatible with the TypeScript configuration.

Field-for-field parity with the settings the TS server and CLI already read
(``packages/server/src/config.ts`` and ``packages/db/src/local.ts``), so one
environment drives both implementations during the migration:

===================  =====================================================
Setting              Environment (highest precedence first)
===================  =====================================================
Install directory    ``NETPRO_HOME`` (default ``~/.netpro``)
Bind address         ``NETPRO_HOST`` / ``HOST`` (default ``127.0.0.1`` —
                     remote exposure must be explicit, never the default)
Port                 ``NETPRO_PORT`` / ``PORT`` (default ``3777``)
Auth mode            ``NETPRO_AUTH_MODE`` (``local`` | ``token`` | ``open``)
Database dialect     ``DB_DIALECT`` (``sqlite`` | ``postgres`` |
                     ``postgresql``; default ``sqlite``)
Auto-migrate         ``NETPRO_AUTO_MIGRATE`` (default on)
Log level            ``NETPRO_LOG_LEVEL`` (default ``INFO``)
===================  =====================================================

Deliberate TS parity details:

* Unknown auth modes and dialects are a loud ``ConfigurationError`` naming
  the setting and the accepted values — never a silent fallback (the TS
  ``parseAuthMode`` / ``parseDialect`` posture).
* ``postgres`` is an alias for ``postgresql``, like ``DIALECT_ALIASES``.
* An unparseable ``NETPRO_PORT``/``PORT`` falls back to 3777 silently —
  exactly the TS ``positivePort`` behaviour (the *config-file* port is the
  loud one; it arrives with Phase 2).
* A set ``DATABASE_URL`` never flips the dialect (TS Phase 4 removed that
  inference); the dialect is what the operator says it is.
* Empty-string values count as unset, like the TS ``trim() ||`` chains.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BeforeValidator, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from netpro.errors import ConfigurationError, NetProError

AuthMode = Literal["local", "token", "open"]
DbDialect = Literal["sqlite", "postgresql"]

DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 3777

#: Mirrors ``DIALECT_ALIASES`` in packages/db/src/local.ts.
_DIALECT_ALIASES: dict[str, DbDialect] = {
    "sqlite": "sqlite",
    "postgres": "postgresql",
    "postgresql": "postgresql",
}

_AUTH_MODES: tuple[AuthMode, ...] = ("local", "token", "open")


def _auth_mode(value: object) -> AuthMode:
    """Validate NETPRO_AUTH_MODE with the TS error message."""
    if not isinstance(value, str) or not value.strip():
        return "local"
    mode = value.strip().lower()
    if mode not in _AUTH_MODES:
        raise ConfigurationError(
            f'Unknown auth mode "{value}" in NETPRO_AUTH_MODE. '
            f'Expected "local", "token", or "open".',
            details={"setting": "NETPRO_AUTH_MODE", "value": value},
        )
    return mode


def _dialect(value: object) -> DbDialect:
    """Validate DB_DIALECT, accepting the TS ``postgres`` alias."""
    if not isinstance(value, str) or not value.strip():
        return "sqlite"
    dialect = _DIALECT_ALIASES.get(value.strip().lower())
    if dialect is None:
        raise ConfigurationError(
            f'Unknown database dialect "{value}" in DB_DIALECT. Expected "sqlite" or "postgresql".',
            details={"setting": "DB_DIALECT", "value": value},
        )
    return dialect


def _port(value: object) -> int:
    """TS ``positivePort``: invalid values silently fall back to 3777."""
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return DEFAULT_SERVER_PORT
    if port < 1 or port > 65535:
        return DEFAULT_SERVER_PORT
    return port


def _host(value: object) -> str:
    """Empty means unset (TS: ``trim() || default``)."""
    if not isinstance(value, str) or not value.strip():
        return DEFAULT_SERVER_HOST
    return value.strip()


def _expand_home(value: object) -> object:
    """Expand a leading ``~/`` like the TS ``expandHomePath``."""
    if isinstance(value, str):
        return Path(value).expanduser()
    return value


class Settings(BaseSettings):
    """Resolved process settings; construct with kwargs to override in tests."""

    model_config = SettingsConfigDict(
        # Case-sensitive on purpose: Node's process.env is case-sensitive, so
        # `netpro_port` was never a valid spelling on the TS side either. It
        # also stops ambient variables (HOME, AUTH_MODE, …) from colliding
        # with field names — only the documented names above count.
        case_sensitive=True,
        # Init kwargs use field names (Settings(server_port=…)) while the
        # environment uses the TS-compatible names above.
        populate_by_name=True,
        extra="ignore",
        # ~/.netpro/config.toml arrives in Phase 2 with the same precedence
        # the TS code uses: environment → config file → local-first default.
        env_file=None,
    )

    # -- identity -----------------------------------------------------------

    app_name: str = "NetPro"

    #: Local install directory (``NETPRO_HOME``). Everything user-owned —
    #: database, logs, keys — lives inside it, exactly like the TS
    #: ``ensureNetProHome`` contract.
    home: Annotated[
        Path,
        Field(validation_alias=AliasChoices("NETPRO_HOME")),
        BeforeValidator(_expand_home),
    ] = Path("~/.netpro").expanduser()

    # -- server (defaults are the local-first posture: loopback only) -------

    server_host: Annotated[
        str,
        Field(validation_alias=AliasChoices("NETPRO_HOST", "HOST")),
        BeforeValidator(_host),
    ] = DEFAULT_SERVER_HOST

    server_port: Annotated[
        int,
        Field(validation_alias=AliasChoices("NETPRO_PORT", "PORT")),
        BeforeValidator(_port),
    ] = DEFAULT_SERVER_PORT

    auth_mode: Annotated[
        AuthMode,
        Field(validation_alias=AliasChoices("NETPRO_AUTH_MODE")),
        BeforeValidator(_auth_mode),
    ] = "local"

    auto_migrate: Annotated[
        bool,
        Field(validation_alias=AliasChoices("NETPRO_AUTO_MIGRATE")),
    ] = True

    # -- database (consumed from Phase 2; the contract is declared now) -----

    db_dialect: Annotated[
        DbDialect,
        Field(validation_alias=AliasChoices("DB_DIALECT")),
        BeforeValidator(_dialect),
    ] = "sqlite"

    # -- process ------------------------------------------------------------

    log_level: Annotated[
        str,
        Field(validation_alias=AliasChoices("NETPRO_LOG_LEVEL")),
    ] = "INFO"

    def __init__(self, **kwargs: Any) -> None:
        """Translate pydantic validation noise into NetPro's error contract.

        A bad ``NETPRO_AUTH_MODE`` or ``DB_DIALECT`` must read like the TS
        error (``Unknown auth mode "…" in NETPRO_AUTH_MODE. Expected …``)
        and carry our ``configuration_error`` code — not a pydantic traceback.
        """
        try:
            super().__init__(**kwargs)
        except ValidationError as exc:
            raise ConfigurationError(
                _humanize_validation_error(exc),
                details={"errors": exc.errors(include_url=False)},
            ) from exc


def _humanize_validation_error(exc: ValidationError) -> str:
    """One readable sentence per bad field; ConfigurationErrors pass through."""
    parts: list[str] = []
    for error in exc.errors(include_url=False):
        # Validators that raise ConfigurationError keep their message: it is
        # already written for humans (and matches the TS wording).
        inner = (error.get("ctx") or {}).get("error")
        if isinstance(inner, NetProError):
            parts.append(str(inner))
            continue
        field = ".".join(str(loc) for loc in error["loc"]) or "settings"
        parts.append(f"{field}: {error['msg']}")
    return "Invalid NetPro settings — " + "; ".join(parts)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings accessor.

    Cached: one environment read per process (env changes after startup are
    ignored on purpose — parity with the TS ``loadConfig`` at app creation).
    Tests and ``netpro serve`` flags construct/override :class:`Settings`
    directly and inject it; they never mutate this cache.
    """
    return Settings()
