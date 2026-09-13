"""CLI skeleton: version parity and the serve command surface."""

from __future__ import annotations

from typer.testing import CliRunner

from netpro import __version__
from netpro.cli.main import app

runner = CliRunner()


class TestVersion:
    def test_version_prints_the_bare_string(self) -> None:
        # Commander parity: `netpro --version` prints "3.0.2" and nothing
        # else — the release smoke scripts assert on the bare version.
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0
        assert result.output.strip() == __version__


class TestSurface:
    def test_help_mentions_serve(self) -> None:
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "serve" in result.output

    def test_no_args_shows_help(self) -> None:
        # click's no_args_is_help prints help and exits 2 (usage-error
        # convention). The TS commander prints help and exits 1; the help
        # surface is the contract that matters, not the exit code.
        result = runner.invoke(app, [])
        assert result.exit_code == 2
        assert "serve" in result.output

    def test_serve_help_documents_defaults(self) -> None:
        result = runner.invoke(app, ["serve", "--help"])
        assert result.exit_code == 0
        assert "127.0.0.1" in result.output
        assert "3777" in result.output
