"""The local install layout: `~/.netpro`, one directory for the whole product.

Mirrors `packages/db/src/local.ts` so a Python process and the TypeScript CLI
agree on where the database, config, logs, and keys live:

```text
~/.netpro/
├── config.toml          # [database] [server] [installation] [auth]
├── netpro.db            # SQLite (WAL, mode 0600)
├── logs/                # mode 0700
└── keys/
    └── access-token     # mode 0600, prefix np_
```

`NETPRO_HOME` relocates the whole install (tests, portable installs,
multi-instance setups) and nothing else needs to change.

Read helpers never create anything: only `ensure_netpro_home` writes, so looking
up a config path has no side effects.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "CONFIG_FILE_NAME",
    "DATABASE_FILE_NAME",
    "DEFAULT_HOME_DIR_NAME",
    "HOME_ENV_VAR",
    "InstallLayout",
    "config_toml_path",
    "default_sqlite_path",
    "ensure_netpro_home",
    "expand_home_path",
    "netpro_home",
    "resolve_sqlite_path",
    "user_home",
]

#: Environment variable that relocates the install directory.
HOME_ENV_VAR = "NETPRO_HOME"

#: Default install directory name inside the user's home.
DEFAULT_HOME_DIR_NAME = ".netpro"

#: Name of the user-editable configuration file.
CONFIG_FILE_NAME = "config.toml"

#: Default SQLite database file name.
DATABASE_FILE_NAME = "netpro.db"

#: Owner-only mode for directories that hold the professional network.
_DIR_MODE = stat.S_IRWXU  # 0o700

EnvMapping = Mapping[str, str]


@dataclass(frozen=True, slots=True)
class InstallLayout:
    """The directories `ensure_netpro_home` guarantees to exist."""

    home: Path
    logs: Path
    keys: Path


def user_home(env: EnvMapping | None = None) -> Path:
    """The user's home directory (`$HOME`, falling back to `Path.home()`)."""
    mapping: EnvMapping = os.environ if env is None else env
    raw = mapping.get("HOME")
    if raw and raw.strip():
        return Path(raw)
    return Path.home()


def expand_home_path(path: str, env: EnvMapping | None = None) -> str:
    """Expand a leading `~` (or `~/`) to the user's home directory.

    Paths that are not home-relative are returned unchanged.
    """
    if path == "~":
        return str(user_home(env))
    if path.startswith(("~/", "~\\")):
        return str(user_home(env) / path[2:])
    return path


def netpro_home(env: EnvMapping | None = None) -> Path:
    """The install directory: `NETPRO_HOME` when set, otherwise `~/.netpro`.

    Does **not** create the directory — use `ensure_netpro_home` for that.
    """
    mapping: EnvMapping = os.environ if env is None else env
    override = (mapping.get(HOME_ENV_VAR) or "").strip()
    if override:
        return Path(expand_home_path(override, mapping))
    return user_home(mapping) / DEFAULT_HOME_DIR_NAME


def config_toml_path(env: EnvMapping | None = None) -> Path:
    """Path of the local config file inside the install directory."""
    return netpro_home(env) / CONFIG_FILE_NAME


def default_sqlite_path(env: EnvMapping | None = None) -> Path:
    """Default SQLite database path: `<home>/netpro.db`."""
    return netpro_home(env) / DATABASE_FILE_NAME


def resolve_sqlite_path(path: str, env: EnvMapping | None = None) -> Path:
    """Resolve a configured SQLite path to an absolute one.

    Relative paths in `config.toml` resolve against the **install directory**,
    not the process cwd, so `path = "netpro.db"` means the same thing wherever
    the server was started from. (`DB_PATH` keeps its historical cwd-based
    behaviour — it is an operator override, not a config-file value.)
    """
    expanded = expand_home_path(path, env)
    if os.path.isabs(expanded):
        return Path(os.path.normpath(expanded))
    base = netpro_home(env)
    return Path(os.path.normpath(os.path.join(str(base), expanded)))


def ensure_netpro_home(env: EnvMapping | None = None) -> InstallLayout:
    """Create `~/.netpro` plus its fixed subdirectories. Idempotent.

    The install directory holds the database, the access token, and backups, so
    everything here is mode 0700. The mode is re-applied on every call so
    installs created by an older build tighten up the next time they are
    touched.
    """
    home = netpro_home(env)
    logs = home / "logs"
    keys = home / "keys"
    for directory in (home, logs, keys):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(_DIR_MODE)
    return InstallLayout(home=home, logs=logs, keys=keys)
