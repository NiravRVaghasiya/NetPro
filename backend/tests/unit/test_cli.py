from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import uvicorn
from typer.testing import CliRunner

from netpro import PRODUCT_BASELINE, __version__
from netpro.cli import app


@pytest.fixture
def runner() -> CliRunner:
    # `mix_stderr=False` is the Typer default in recent releases; the runner
    # exposes `.stdout` and `.stderr` either way.
    return CliRunner()


def test_version_prints_a_human_line(runner: CliRunner) -> None:
    result = runner.invoke(app, ["version"])

    assert result.exit_code == 0
    assert f"netpro-backend {__version__}" in result.stdout
    assert PRODUCT_BASELINE in result.stdout


def test_version_json_is_the_same_object_the_api_reports(runner: CliRunner) -> None:
    result = runner.invoke(app, ["version", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload == {
        "backend": "python",
        "version": __version__,
        "productBaseline": PRODUCT_BASELINE,
        "service": "@netpro/server",
    }


def test_the_version_flag_is_eager(runner: CliRunner) -> None:
    result = runner.invoke(app, ["--version"])

    assert result.exit_code == 0
    assert f"netpro-backend {__version__}" in result.stdout


def test_help_names_the_two_phase_1_commands(runner: CliRunner) -> None:
    result = runner.invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "version" in result.stdout
    assert "serve" in result.stdout


def test_no_args_shows_help(runner: CliRunner) -> None:
    result = runner.invoke(app, [])

    assert result.exit_code != 0
    assert "Usage" in result.stdout


def test_serve_binds_the_configured_address(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, netpro_home: Path
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(application: Any, **kwargs: Any) -> None:
        captured["app"] = application
        captured.update(kwargs)

    monkeypatch.setattr(uvicorn, "run", fake_run)

    result = runner.invoke(app, ["serve", "--host", "127.0.0.1", "--port", "4321"])

    assert result.exit_code == 0, result.output
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 4321
    assert "4321/api/health" in result.output


def test_serve_warns_loudly_about_a_public_bind(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, netpro_home: Path
) -> None:
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: None)

    result = runner.invoke(app, ["serve", "--host", "0.0.0.0", "--port", "4321"])

    assert result.exit_code == 0
    assert "WARNING" in result.output
    assert "Phase 15" in result.output
