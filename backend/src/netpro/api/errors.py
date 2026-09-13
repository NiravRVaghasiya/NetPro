"""Map NetPro's error hierarchy onto HTTP with the TS response shape.

Every deliberate failure from any surface serializes as::

    {"error": "<human message>", "code": "<stable machine code>"}

— the exact body the TypeScript routes emit (``sendJson(res, 404, {error:
…, code: 'not_found'})``). The web UI keeps working unchanged when a route's
implementation crosses the language boundary.

Unhandled exceptions become a 500 without leaking internals; the details
live in the server log (with the request id), not the response.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from netpro.errors import NetProError

_CACHE_CONTROL = {"Cache-Control": "no-store, max-age=0"}


def _error_response(status: int, message: str, code: str | None = None) -> JSONResponse:
    # `code` is omitted when None — the TS fallback 404 sends error-only.
    body: dict[str, str] = {"error": message}
    if code is not None:
        body["code"] = code
    return JSONResponse(status_code=status, content=body, headers=_CACHE_CONTROL)


def install_error_handlers(app: FastAPI) -> None:
    """Attach the uniform error handlers to an application."""

    @app.exception_handler(NetProError)
    async def _netpro_error(_: Request, exc: NetProError) -> JSONResponse:
        return _error_response(exc.http_status, str(exc), exc.code)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Unknown API routes answer exactly like the TS fallback: JSON with
        # "Not found: <method> <path>" — the web UI must never see HTML.
        if exc.status_code == 404 and request.url.path.startswith("/api"):
            return _error_response(404, f"Not found: {request.method} {request.url.path}")
        return _error_response(exc.status_code, str(exc.detail), "http_error")

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        # The TS body parser rejects malformed input with a plain 400; the
        # FastAPI default (422 + verbose list) is a different contract, so
        # request-shape problems collapse to the same readable 400.
        return _error_response(400, "Request body must be a valid JSON object.", "invalid_request")

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # Log with the request id context (set by the middleware); answer
        # with a generic body — stack traces and raw messages never escape.
        import logging

        logging.getLogger("netpro.api").exception("Unhandled error: %s", type(exc).__name__)
        return _error_response(500, "Internal server error.", "internal_error")
