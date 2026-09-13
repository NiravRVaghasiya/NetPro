"""Settings: defaults, TS-compatible env names, and loud failures."""

from __future__ import annotations

from pathlib import Path

import pytest

from netpro.config import Settings
from netpro.errors import ConfigurationError


class TestDefaults:
    def test_local_first_defaults(self) -> None:
        settings = Settings()
        assert settings.server_host == "127.0.0.1"  # loopback only, never 0.0.0.0
        assert settings.server_port == 3777
        assert settings.auth_mode == "local"
        assert settings.db_dialect == "sqlite"
        assert settings.auto_migrate is True

    def test_home_defaults_to_netpro_dir(self) -> None:
        assert Settings().home == Path("~/.netpro").expanduser()


class TestEnvOverrides:
    def test_netpro_host_and_port(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_HOST", "0.0.0.0")
        monkeypatch.setenv("NETPRO_PORT", "8080")
        settings = Settings()
        assert settings.server_host == "0.0.0.0"
        assert settings.server_port == 8080

    def test_host_and_port_aliases(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HOST", "192.168.1.10")
        monkeypatch.setenv("PORT", "9000")
        settings = Settings()
        assert settings.server_host == "192.168.1.10"
        assert settings.server_port == 9000

    def test_netpro_prefix_wins_over_alias(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_PORT", "1111")
        monkeypatch.setenv("PORT", "2222")
        assert Settings().server_port == 1111

    def test_netpro_home_expands_tilde(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_HOME", "~/somewhere-netpro")
        assert Settings().home == Path.home() / "somewhere-netpro"

    def test_auth_mode_and_dialect(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_AUTH_MODE", "token")
        monkeypatch.setenv("DB_DIALECT", "postgres")
        settings = Settings()
        assert settings.auth_mode == "token"
        assert settings.db_dialect == "postgresql"  # alias normalized


class TestLoudFailures:
    def test_unknown_auth_mode_is_rejected_with_the_ts_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NETPRO_AUTH_MODE", "lokal")
        with pytest.raises(ConfigurationError, match='Unknown auth mode "lokal"'):
            Settings()

    def test_unknown_dialect_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DB_DIALECT", "mysql")
        with pytest.raises(ConfigurationError, match='Unknown database dialect "mysql"'):
            Settings()

    def test_error_carries_the_code_and_details(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_AUTH_MODE", "nope")
        with pytest.raises(ConfigurationError) as exc_info:
            Settings()
        assert exc_info.value.code == "configuration_error"
        assert exc_info.value.http_status == 500
        assert exc_info.value.details  # structured context for logs


class TestTsParityEdgeCases:
    def test_invalid_port_falls_back_to_default_silently(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # TS positivePort(): an unparseable env port silently uses 3777.
        monkeypatch.setenv("NETPRO_PORT", "not-a-number")
        assert Settings().server_port == 3777

    def test_empty_host_env_counts_as_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_HOST", "   ")
        assert Settings().server_host == "127.0.0.1"

    def test_empty_dialect_env_counts_as_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DB_DIALECT", "")
        assert Settings().db_dialect == "sqlite"


class TestEnvironmentIsolation:
    """Regression tests: only the documented env names may reach Settings.

    pydantic-settings matches bare field names when ``populate_by_name`` is
    on; with case-sensitive matching (Node's ``process.env`` is
    case-sensitive too) ambient variables like ``HOME`` or ``AUTH_MODE``
    must never leak into settings.
    """

    def test_home_env_does_not_leak_into_the_install_dir(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Resolve the expectation first: with the real HOME, like the frozen
        # class default. Then prove a different HOME cannot change it.
        expected = Path("~/.netpro").expanduser()
        monkeypatch.setenv("HOME", "/tmp/somewhere-else")
        assert Settings().home == expected

    def test_bare_auth_mode_env_does_not_leak(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AUTH_MODE", "open")
        assert Settings().auth_mode == "local"

    def test_lowercase_env_names_do_not_count(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Node's process.env is case-sensitive: "netpro_port" is not a
        # spelling the TS server ever read, so it must not count here.
        monkeypatch.setenv("netpro_port", "9999")
        assert Settings().server_port == 3777


class TestInjection:
    def test_kwargs_override_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NETPRO_PORT", "1234")
        settings = Settings(server_port=5678, server_host="10.0.0.1")
        assert settings.server_port == 5678
        assert settings.server_host == "10.0.0.1"
