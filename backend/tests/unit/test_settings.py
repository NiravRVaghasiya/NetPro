from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest

from netpro.config import LocalConfigError, load_settings, read_local_config


def write(tmp_home: Path, text: str) -> None:
    (tmp_home / "config.toml").write_text(text, encoding="utf-8")


def test_defaults_need_no_configuration_at_all(env: Mapping[str, str], netpro_home: Path) -> None:
    settings = load_settings(env)

    assert settings.home == netpro_home
    assert settings.database.dialect == "sqlite"
    assert settings.database.path == netpro_home / "netpro.db"
    assert settings.database.source == "default"
    assert settings.server.host == "127.0.0.1"
    assert settings.server.port == 3777
    assert settings.server.is_loopback_bind is True
    assert settings.server.auto_migrate is True
    assert settings.server.hsts is False
    assert settings.server.allowed_origins is None
    assert settings.auth.mode == "local"
    assert settings.installation.id is None


def test_config_file_values_are_read(env: Mapping[str, str], netpro_home: Path) -> None:
    write(
        netpro_home,
        """
[database]
dialect = "sqlite"
path = "data/netpro.db"

[server]
host = "127.0.0.1"
port = 4000
allowed_origins = "http://localhost:3000, http://127.0.0.1:3000"
web_url = "http://localhost:3000"

[auth]
mode = "token"

[installation]
id = "ins_0f1e2d3c4b5a69788796a5b4"
owner = "Ada"
""",
    )

    settings = load_settings(env)

    assert settings.database.source == "config"
    assert settings.database.path == netpro_home / "data" / "netpro.db"
    assert settings.server.port == 4000
    assert settings.server.allowed_origins == (
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    )
    assert settings.server.web_url == "http://localhost:3000"
    assert settings.auth.mode == "token"
    assert settings.installation.id == "ins_0f1e2d3c4b5a69788796a5b4"
    assert settings.installation.owner == "Ada"


def test_environment_beats_the_config_file(env: Mapping[str, str], netpro_home: Path) -> None:
    write(netpro_home, '[server]\nport = 4000\n\n[auth]\nmode = "token"\n')
    overrides = dict(env)
    overrides.update({"NETPRO_PORT": "4100", "NETPRO_AUTH_MODE": "open"})

    settings = load_settings(overrides)

    assert settings.server.port == 4100
    assert settings.auth.mode == "open"


def test_legacy_host_and_port_names_still_work(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides.update({"HOST": "127.0.0.2", "PORT": "4200"})

    settings = load_settings(overrides)

    assert settings.server.host == "127.0.0.2"
    assert settings.server.port == 4200
    assert settings.server.is_loopback_bind is True


def test_an_unparseable_port_falls_back_like_the_ts_helper(
    env: Mapping[str, str], netpro_home: Path
) -> None:
    write(netpro_home, "[server]\nport = 4000\n")
    overrides = dict(env)
    overrides["NETPRO_PORT"] = "not-a-port"

    assert load_settings(overrides).server.port == 4000


def test_flags_accept_the_documented_false_spellings(env: Mapping[str, str]) -> None:
    for raw in ("0", "false", "no", "off"):
        overrides = dict(env)
        overrides["NETPRO_AUTO_MIGRATE"] = raw
        assert load_settings(overrides).server.auto_migrate is False

    overrides = dict(env)
    overrides["NETPRO_AUTO_MIGRATE"] = "1"
    assert load_settings(overrides).server.auto_migrate is True


def test_hsts_is_opt_in(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["NETPRO_HSTS"] = "1"
    assert load_settings(overrides).server.hsts is True


def test_postgres_requires_a_url(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["DB_DIALECT"] = "postgres"

    with pytest.raises(LocalConfigError) as excinfo:
        load_settings(overrides)

    assert 'DATABASE_URL is required when the database dialect is "postgresql"' in str(
        excinfo.value
    )
    assert excinfo.value.code == "invalid_local_config"


def test_postgres_accepts_the_url_from_either_source(
    env: Mapping[str, str], netpro_home: Path
) -> None:
    overrides = dict(env)
    overrides["DB_DIALECT"] = "postgresql"
    overrides["DATABASE_URL"] = "postgresql://user:secret@db.test:5432/netpro"

    settings = load_settings(overrides)

    assert settings.database.dialect == "postgresql"
    assert settings.database.url == "postgresql://user:secret@db.test:5432/netpro"
    assert settings.database.source == "env"
    # The printable form must never carry the password.
    assert "secret" not in settings.describe_database()
    assert "user:***@db.test:5432/netpro" in settings.describe_database()


def test_a_set_database_url_never_flips_the_dialect(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["DATABASE_URL"] = "postgresql://db.test:5432/netpro"

    assert load_settings(overrides).database.dialect == "sqlite"


def test_db_path_is_expanded_but_not_rebased(env: Mapping[str, str], tmp_path: Path) -> None:
    overrides = dict(env)
    overrides["DB_PATH"] = "~/other.db"

    assert load_settings(overrides).database.path == tmp_path / "other.db"


def test_unknown_dialect_is_a_loud_error(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["DB_DIALECT"] = "mysql"

    with pytest.raises(LocalConfigError, match='Unknown database dialect "mysql" in DB_DIALECT'):
        load_settings(overrides)


def test_unknown_auth_mode_is_a_loud_error(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["NETPRO_AUTH_MODE"] = "oauth"

    with pytest.raises(LocalConfigError, match='Unknown auth mode "oauth" in NETPRO_AUTH_MODE'):
        load_settings(overrides)


def test_unknown_section_is_rejected(env: Mapping[str, str], netpro_home: Path) -> None:
    write(netpro_home, '[cloud]\nregion = "eu"\n')

    with pytest.raises(LocalConfigError) as excinfo:
        load_settings(env)

    assert "unknown section [cloud]" in str(excinfo.value)
    assert "(NetPro understands [database], [server], [installation], and [auth])" in str(
        excinfo.value
    )


def test_unknown_server_key_is_rejected(env: Mapping[str, str], netpro_home: Path) -> None:
    write(netpro_home, "[server]\nprot = 4000\n")

    with pytest.raises(LocalConfigError) as excinfo:
        load_settings(env)

    assert 'unknown key "prot" in [server]' in str(excinfo.value)


def test_out_of_range_port_is_rejected(env: Mapping[str, str], netpro_home: Path) -> None:
    write(netpro_home, "[server]\nport = 70000\n")

    with pytest.raises(LocalConfigError, match=r"\[server\] port must be an integer"):
        load_settings(env)


def test_toml_syntax_errors_are_wrapped_with_the_file_and_line(
    env: Mapping[str, str], netpro_home: Path
) -> None:
    write(netpro_home, "[server]\nport = 4000\noops\n")

    with pytest.raises(LocalConfigError) as excinfo:
        load_settings(env)

    message = str(excinfo.value)
    assert str(netpro_home / "config.toml") in message
    assert "config.toml line 3" in message


def test_empty_string_values_are_rejected(env: Mapping[str, str], netpro_home: Path) -> None:
    write(netpro_home, '[server]\nhost = "  "\n')

    with pytest.raises(LocalConfigError, match=r"config\.toml \[server\] host must be a non-empty"):
        load_settings(env)


def test_missing_file_is_an_empty_config(env: Mapping[str, str], netpro_home: Path) -> None:
    config = read_local_config(env)

    assert config.path == netpro_home / "config.toml"
    assert config.database is None
    assert config.server is None
    assert config.installation is None
    assert config.auth is None
    assert config.raw == {}


def test_public_settings_expose_no_credentials(env: Mapping[str, str]) -> None:
    overrides = dict(env)
    overrides["DB_DIALECT"] = "postgresql"
    overrides["DATABASE_URL"] = "postgresql://user:secret@db.test:5432/netpro"

    public = load_settings(overrides).to_public_dict()

    assert "secret" not in str(public)
    assert public["database"]["dialect"] == "postgresql"
    assert public["server"]["port"] == 3777
    assert public["auth"]["mode"] == "local"
