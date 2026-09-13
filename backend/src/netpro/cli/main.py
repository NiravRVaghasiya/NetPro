"""``netpro`` command-line entry point.

Phase 1 skeleton: ``--version`` and ``serve``. The command tree grows phase
by phase (``init`` → Phase 2, ``people``/``search``/``graph`` → Phases 4-6,
…) until Typer replaces Commander as the authoritative CLI — always through
the same application use cases the API uses.

Parity notes:

* ``netpro --version`` prints the bare version string, exactly like
  Commander's default — the release smoke scripts assert on it, and the
  number is pinned to the workspace version (like
  ``apps/cli/src/bundle.test.ts`` pins the TS side).
* ``serve`` binds loopback:3777 by default. Exposing it further is an
  explicit ``--host`` choice, never the default — the TS posture.
"""

from __future__ import annotations

from typing import Annotated

import typer
import uvicorn

from netpro import __version__
from netpro.api import create_app
from netpro.config import get_settings
from netpro.observability import configure_logging

app = typer.Typer(
    name="netpro",
    help="NetPro — your professional network, owned by you.",
    no_args_is_help=True,
    add_completion=False,
)


def _version_callback(value: bool) -> None:
    if value:
        # Bare version string — Commander parity (its --version prints
        # "3.0.2", not "netpro 3.0.2").
        typer.echo(__version__)
        raise typer.Exit


@app.callback()
def main(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            callback=_version_callback,
            is_eager=True,
            help="Show the version and exit.",
        ),
    ] = False,
) -> None:
    """NetPro — local-first professional relationship intelligence."""


@app.command()
def serve(
    host: Annotated[
        str | None,
        typer.Option("--host", help="Bind address (default 127.0.0.1 — loopback only)."),
    ] = None,
    port: Annotated[int | None, typer.Option("--port", help="TCP port (default 3777).")] = None,
) -> None:
    """Run the local NetPro API server (FastAPI)."""
    settings = get_settings()
    if host is not None:
        settings = settings.model_copy(update={"server_host": host})
    if port is not None:
        settings = settings.model_copy(update={"server_port": port})
    configure_logging(settings.log_level)
    uvicorn.run(
        create_app(settings),
        host=settings.server_host,
        port=settings.server_port,
        log_level=settings.log_level.lower(),
    )


def run() -> None:
    """Console-script entry point (pyproject: ``netpro = …main:run``)."""
    app()
