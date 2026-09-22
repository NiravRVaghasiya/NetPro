"""The HTTP error envelope and the exception handlers that produce it.

Frozen by `docs/python-migration/api-contracts.md`:

- Every error is JSON, never HTML — even a 404 for a path that does not exist.
- Unknown `/api/*` → `404 {"error": "Not found: METHOD path"}`. The TypeScript
  router matches method *and* path together, so an unsupported method on a
  known path is also a 404 (not a 405). Preserved deliberately.
- Anything outside `/api` → `404 {"error": "Not found"}`.
- An uncaught error → `500 {"error": "Internal server error", "message": ...}`.
- `NetProError` subclasses render their own `code`-shaped body
  (`UnauthorizedError` reproduces the captured 401 fixture exactly).

JSON responses also carry `Content-Type: application/json; charset=utf-8` and
`Cache-Control: no-store, max-age=0`, because a local API must never be cached
by a browser or a proxy.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from netpro.domain.errors import NetProError

__all__ = [
    "CACHE_CONTROL",
    "JSON_MEDIA_TYPE",
    "NetProJSONResponse",
    "error_response",
    "install_exception_handlers",
]

#: The content type the TypeScript server sends on every JSON body.
JSON_MEDIA_TYPE = "application/json; charset=utf-8"

#: Local-first: never cache an API response anywhere.
CACHE_CONTROL = "no-store, max-age=0"


class NetProJSONResponse(JSONResponse):
    """JSON with the frozen content type and cache policy applied."""

    media_type = JSON_MEDIA_TYPE

    def __init__(
        self,
        content: Any = None,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        """Serialise `content` and apply the frozen cache policy."""
        merged = {"Cache-Control": CACHE_CONTROL, **(headers or {})}
        super().__init__(content=content, status_code=status_code, headers=merged, **kwargs)


def error_response(
    status_code: int,
    error: str,
    *,
    headers: dict[str, str] | None = None,
    **extra: Any,
) -> Response:
    """Build a `{"error": ..., ...}` response."""
    return NetProJSONResponse(
        content={"error": error, **extra},
        status_code=status_code,
        headers=headers,
    )


def install_exception_handlers(app: FastAPI) -> None:
    """Route every failure through the NetPro envelope."""

    @app.exception_handler(NetProError)
    async def _netpro_error(request: Request, exc: NetProError) -> Response:
        return NetProJSONResponse(
            content=exc.to_payload(),
            status_code=exc.status_code,
            headers=exc.headers or None,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> Response:
        path = request.url.path
        method = request.method
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)

        if path.startswith("/api"):
            # The TS router keys on method+path, so 405 is not a thing it emits.
            if exc.status_code in {404, 405}:
                return error_response(404, f"Not found: {method} {path}")
            return error_response(exc.status_code, detail)

        if exc.status_code in {404, 405}:
            return error_response(404, "Not found")
        return error_response(exc.status_code, detail)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> Response:
        return error_response(
            422,
            "Request validation failed.",
            details=_serialisable_errors(exc.errors()),
        )

    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, exc: Exception) -> Response:
        # The message is surfaced because the only caller is the local operator;
        # a remote deployment puts a proxy in front that replaces it.
        return error_response(500, "Internal server error", message=str(exc))


def _serialisable_errors(errors: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Strip the non-JSON-safe parts (`ctx`, `url`) out of Pydantic errors."""
    return [
        {
            "field": ".".join(str(part) for part in error.get("loc", ())),
            "message": error.get("msg", ""),
            "type": error.get("type", ""),
        }
        for error in errors
    ]
