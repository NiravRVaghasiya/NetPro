"""The Python `netpro` CLI — two commands in Phase 1.

`netpro version` reports what this backend is, and `netpro serve` runs the API
so the public probes can be exercised beside the TypeScript server. The full
27-command surface migrates in Phase 13; until then the npm `netpro` binary is
the product CLI and this one is the migration's front door.

Global conventions, established here and kept by every later command:

- `--json` prints the same object the HTTP API returns.
- Errors go to stderr with a non-zero exit code; a `NetProError` renders its
  `error`/`code` envelope so `--json` callers can branch on it.
- No command reaches the network unless the user asked for it explicitly.
"""

from __future__ import annotations

from typing import Any

import typer

from netpro import PRODUCT_BASELINE, __version__
from netpro.cli.output import emit
from netpro.domain.errors import NetProError

__all__ = ["app", "main"]

app = typer.Typer(
    name="netpro",
    add_completion=False,
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    help="NetPro — local-first professional relationship intelligence (Python backend).",
)


def _print_version(value: bool) -> None:
    if not value:
        return
    typer.echo(f"netpro-backend {__version__} (product baseline {PRODUCT_BASELINE})")
    raise typer.Exit


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_print_version,
        is_eager=True,
        help="Show the backend version and exit.",
    ),
) -> None:
    """NetPro's Python backend.

    This is the migration foundation: the domain, graph, search, and CRM
    capabilities still live in the TypeScript `@netpro/core`.
    """


@app.command()
def version(
    as_json: bool = typer.Option(False, "--json", help="Print the version payload as JSON."),
) -> None:
    """Show the backend version and the TypeScript baseline it migrates from."""
    payload: dict[str, Any] = {
        "backend": "python",
        "version": __version__,
        "productBaseline": PRODUCT_BASELINE,
        "service": "@netpro/server",
    }
    emit(
        payload,
        as_json=as_json,
        human=lambda data: (
            f"netpro-backend {data['version']} — Python foundation for NetPro "
            f"{data['productBaseline']}"
        ),
    )


@app.command()
def serve(
    host: str | None = typer.Option(
        None,
        "--host",
        help="Bind address (default: [server] host or 127.0.0.1).",
    ),
    port: int | None = typer.Option(
        None,
        "--port",
        help="TCP port (default: [server] port or 3777).",
    ),
    log_level: str = typer.Option("info", "--log-level", help="Uvicorn log level."),
) -> None:
    """Run the Python API server (public probes only, in Phase 1)."""
    import uvicorn

    from netpro.api import build_container, create_app
    from netpro.config import load_settings

    settings = load_settings()
    bind_host = host or settings.server.host
    bind_port = port or settings.server.port

    if bind_host.strip().lower() not in {"127.0.0.1", "localhost", "::1"}:
        typer.secho(
            f"WARNING: binding {bind_host} exposes NetPro beyond this machine. "
            "The Python backend does not verify access tokens yet (migration "
            "Phase 15) — bind a loopback address until it does.",
            fg=typer.colors.YELLOW,
            err=True,
        )

    server_settings = settings.server.model_copy(update={"host": bind_host, "port": bind_port})
    resolved = settings.model_copy(update={"server": server_settings})
    application = create_app(build_container(resolved, version=__version__))

    typer.secho(
        f"NetPro Python backend (foundation) — http://{bind_host}:{bind_port}/api/health",
        fg=typer.colors.CYAN,
        err=True,
    )
    uvicorn.run(application, host=bind_host, port=bind_port, log_level=log_level)


def main() -> None:
    """Entry point for the `netpro` console script."""
    try:
        app()
    except NetProError as error:
        typer.secho(f"{error.code}: {error.message}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from error


if __name__ == "__main__":
    main()
