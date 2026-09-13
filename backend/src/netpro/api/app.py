"""FastAPI application factory — the Phase 1 skeleton.

Composition root for the HTTP surface: settings in, middleware and routes
wired, no business logic. The pattern mirrors the TS ``createApp`` in
``packages/server/src/app.ts`` (config → db → jobs → events → handler) minus
everything Phase 2+ adds.

Conventions established here that every later phase inherits:

* ``create_app(settings | None)`` — dependency injection over globals so
  tests build isolated apps and ``netpro serve`` can apply CLI flag
  overrides without touching process state.
* ``x-request-id`` on every response (reusing an incoming id, capped at 128
  chars — the exact ``assignRequestId`` behaviour), bound to a ContextVar so
  log lines inside a request carry it.
* ``Cache-Control: no-store`` on API responses, like the TS ``sendJson``.
* The OpenAPI docs stay enabled while the API is a skeleton; whether they
  ship in the final posture is a Phase 12 decision.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response

from netpro import __version__
from netpro.api.errors import install_error_handlers
from netpro.api.routes.health import router as health_router
from netpro.config import Settings, get_settings
from netpro.observability import configure_logging, request_id_var

#: Header used for request correlation — same name as the TS server.
REQUEST_ID_HEADER = "x-request-id"

_TRUSTED_ID_MAX_CHARS = 128


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    # configure_logging is idempotent; CLI and tests may have called it
    # already with a different level — the app's settings win here.
    settings: Settings = app.state.settings
    configure_logging(settings.log_level)
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build a NetPro API application.

    Args:
        settings: Injected settings (tests, CLI flag overrides). Falls back
            to the process-wide :func:`get_settings` — one environment read
            per process, like the TS ``loadConfig`` at app creation.
    """
    resolved = settings if settings is not None else get_settings()

    app = FastAPI(
        title="NetPro API",
        version=__version__,
        description="Local-first professional relationship intelligence.",
        lifespan=_lifespan,
    )
    app.state.settings = resolved

    install_error_handlers(app)
    app.include_router(health_router)

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Assign/reuse the request id, expose it on the response, and keep it
        # in a ContextVar so any log line during this request carries it.
        incoming = request.headers.get(REQUEST_ID_HEADER, "").strip()
        request_id = incoming[:_TRUSTED_ID_MAX_CHARS] if incoming else str(uuid.uuid4())
        request_id_var.set(request_id)
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        # API responses are never cacheable (parity with the TS sendJson).
        if request.url.path.startswith("/api") and "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    return app


# Module-level app for `uvicorn netpro.api.app:app` (settings from env).
app = create_app()
