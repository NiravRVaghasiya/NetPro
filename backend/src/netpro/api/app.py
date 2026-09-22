"""The FastAPI application factory.

`create_app()` is the only way to build the app, so every surface — uvicorn,
the CLI, and the tests — gets the same middleware, exception handlers, and
route set. Tests pass their own `ApiContainer` (fake probe, fixed clock) and
exercise the real application object.

Interactive API docs are disabled: this server binds to `127.0.0.1` by default
and ships no browsable surface. The contract lives in
`docs/python-migration/api-contracts.md`.
"""

from __future__ import annotations

from fastapi import FastAPI

from netpro import __version__
from netpro.api.container import ApiContainer, build_container
from netpro.api.errors import NetProJSONResponse, install_exception_handlers
from netpro.api.middleware import NetProHeadersMiddleware
from netpro.api.routes import probes
from netpro.config.settings import Settings

__all__ = ["create_app"]


def create_app(
    container: ApiContainer | None = None,
    *,
    settings: Settings | None = None,
) -> FastAPI:
    """Build the NetPro API application."""
    resolved = (
        container if container is not None else build_container(settings, version=__version__)
    )

    app = FastAPI(
        title="NetPro",
        version=__version__,
        summary="Local-first professional relationship intelligence",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        default_response_class=NetProJSONResponse,
    )
    app.state.container = resolved

    app.add_middleware(NetProHeadersMiddleware, hsts=resolved.settings.server.hsts)
    install_exception_handlers(app)
    app.include_router(probes.router)
    return app
