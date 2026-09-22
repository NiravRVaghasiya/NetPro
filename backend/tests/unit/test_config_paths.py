from __future__ import annotations

import stat
from pathlib import Path

from netpro.config.paths import (
    config_toml_path,
    default_sqlite_path,
    ensure_netpro_home,
    expand_home_path,
    netpro_home,
    resolve_sqlite_path,
    user_home,
)


def test_default_home_is_dot_netpro_under_the_user_home(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path)}
    assert user_home(env) == tmp_path
    assert netpro_home(env) == tmp_path / ".netpro"
    assert config_toml_path(env) == tmp_path / ".netpro" / "config.toml"
    assert default_sqlite_path(env) == tmp_path / ".netpro" / "netpro.db"


def test_netpro_home_relocates_the_whole_install(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path), "NETPRO_HOME": str(tmp_path / "elsewhere")}
    assert netpro_home(env) == tmp_path / "elsewhere"
    assert default_sqlite_path(env) == tmp_path / "elsewhere" / "netpro.db"


def test_netpro_home_expands_a_leading_tilde(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path), "NETPRO_HOME": "~/portable"}
    assert netpro_home(env) == tmp_path / "portable"
    assert expand_home_path("~", env) == str(tmp_path)
    assert expand_home_path("relative/path", env) == "relative/path"


def test_configured_sqlite_path_resolves_against_the_install_dir(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path), "NETPRO_HOME": str(tmp_path / "install")}
    assert resolve_sqlite_path("netpro.db", env) == tmp_path / "install" / "netpro.db"
    assert resolve_sqlite_path("data/netpro.db", env) == tmp_path / "install" / "data" / "netpro.db"
    assert resolve_sqlite_path("~/other.db", env) == tmp_path / "other.db"
    assert resolve_sqlite_path("/srv/netpro.db", env) == Path("/srv/netpro.db")


def test_ensure_netpro_home_creates_owner_only_directories(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path)}
    layout = ensure_netpro_home(env)

    assert layout.home == tmp_path / ".netpro"
    for directory in (layout.home, layout.logs, layout.keys):
        assert directory.is_dir()
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700


def test_ensure_netpro_home_tightens_an_existing_install(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path)}
    home = tmp_path / ".netpro"
    home.mkdir(mode=0o755)

    ensure_netpro_home(env)

    assert stat.S_IMODE(home.stat().st_mode) == 0o700
