"""Configuration: install layout, the `config.toml` subset, resolved settings.

Environment → `config.toml` → defaults. Read helpers never write; only
`ensure_netpro_home` touches the filesystem.
"""

from __future__ import annotations

from netpro.config.paths import (
    CONFIG_FILE_NAME,
    DATABASE_FILE_NAME,
    HOME_ENV_VAR,
    InstallLayout,
    config_toml_path,
    default_sqlite_path,
    ensure_netpro_home,
    expand_home_path,
    netpro_home,
    resolve_sqlite_path,
    user_home,
)
from netpro.config.settings import (
    AUTH_MODES,
    DEFAULT_AUTH_MODE,
    DEFAULT_HOST,
    DEFAULT_PORT,
    AuthMode,
    AuthSettings,
    DatabaseSettings,
    DbDialect,
    InstallationSettings,
    LocalConfig,
    ServerSettings,
    Settings,
    load_settings,
    parse_auth_mode,
    parse_dialect,
    read_local_config,
)
from netpro.config.toml_subset import TomlSubsetError, TomlTable, parse_toml
from netpro.domain.errors import LocalConfigError

__all__ = [
    "AUTH_MODES",
    "CONFIG_FILE_NAME",
    "DATABASE_FILE_NAME",
    "DEFAULT_AUTH_MODE",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "HOME_ENV_VAR",
    "AuthMode",
    "AuthSettings",
    "DatabaseSettings",
    "DbDialect",
    "InstallLayout",
    "InstallationSettings",
    "LocalConfig",
    "LocalConfigError",
    "ServerSettings",
    "Settings",
    "TomlSubsetError",
    "TomlTable",
    "config_toml_path",
    "default_sqlite_path",
    "ensure_netpro_home",
    "expand_home_path",
    "load_settings",
    "netpro_home",
    "parse_auth_mode",
    "parse_dialect",
    "parse_toml",
    "read_local_config",
    "resolve_sqlite_path",
    "user_home",
]
