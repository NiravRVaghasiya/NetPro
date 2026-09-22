"""ASGI middleware: request ids and the hardening headers on every response.

Ported from `packages/server/src/middleware/request-id.ts` and `security.ts`:

- `X-Request-Id` is echoed when the caller supplied one (trimmed, capped at 128
  characters) and generated otherwise, so a log line and a client report can
  always be joined.
- Every response carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- `Strict-Transport-Security` is sent only when the operator opted in: sending
  it over plain HTTP would be a lie.
- `Cache-Control: no-store, max-age=0` is the default unless a route set one.

Written as a pure ASGI middleware (not `BaseHTTPMiddleware`) so the SSE stream
Phase 11 adds is not buffered by an extra task per request.

CORS and per-IP rate limiting are **not** here yet — they are migration
Phase 15, together with credential verification.
"""

from __future__ import annotations

import uuid

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from netpro.api.errors import CACHE_CONTROL

__all__ = [
    "HSTS_HEADER_VALUE",
    "REQUEST_ID_HEADER",
    "REQUEST_ID_MAX_LENGTH",
    "NetProHeadersMiddleware",
    "request_id_of",
]

#: Header used for request correlation, in and out.
REQUEST_ID_HEADER = "x-request-id"

#: A caller-supplied id longer than this is truncated (matches the TS server).
REQUEST_ID_MAX_LENGTH = 128

#: HSTS value, sent only when TLS terminates in front of NetPro.
HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains"

_SCOPE_KEY = "netpro"


class NetProHeadersMiddleware:
    """Assign a request id and apply the hardening headers."""

    def __init__(self, app: ASGIApp, *, hsts: bool = False) -> None:
        """Wrap `app`; set `hsts` only behind a TLS-terminating proxy."""
        self.app = app
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Wrap the response with NetPro's headers, and publish the request id."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or str(uuid.uuid4())
        state = scope.setdefault(_SCOPE_KEY, {})
        state["request_id"] = request_id

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers[REQUEST_ID_HEADER] = request_id
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "no-referrer"
                if self.hsts:
                    headers["Strict-Transport-Security"] = HSTS_HEADER_VALUE
                if "cache-control" not in headers:
                    headers["Cache-Control"] = CACHE_CONTROL
            await send(message)

        await self.app(scope, receive, send_with_headers)


def request_id_of(request: Request) -> str | None:
    """The request id assigned by the middleware, when it ran."""
    state = request.scope.get(_SCOPE_KEY)
    if isinstance(state, dict):
        value = state.get("request_id")
        return str(value) if value is not None else None
    return None


def _incoming_request_id(scope: Scope) -> str | None:
    raw_headers: list[tuple[bytes, bytes]] = scope.get("headers") or []
    for name, value in raw_headers:
        if name.decode("latin-1").lower() == REQUEST_ID_HEADER:
            candidate = value.decode("latin-1").strip()
            if candidate:
                return candidate[:REQUEST_ID_MAX_LENGTH]
    return None
