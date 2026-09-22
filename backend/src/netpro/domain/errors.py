"""Structured errors — one shape, from domain to HTTP.

Every NetPro failure carries three things: a stable machine-readable `code`,
a human-readable `message`, and optional `details`. The API layer renders that
triple as `{"error": <message>, ...}` — the envelope the TypeScript server has
always sent (`docs/python-migration/api-contracts.md`) — so a Python failure is
indistinguishable from the TypeScript one it replaces.

Rules:

- Raise a `NetProError` subclass, never a bare `Exception`, from domain and
  application code. Bare exceptions become a 500 with a generic message.
- `code` is snake_case and part of the contract: renaming one is a breaking
  change and needs an ADR.
- Never interpolate a credential into `message` or `details`. The logging layer
  redacts known secret shapes as a backstop, not as a licence.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "ConfigError",
    "ConflictError",
    "ForbiddenError",
    "LocalConfigError",
    "NetProError",
    "NotFoundError",
    "ProviderUnavailableError",
    "RateLimitedError",
    "UnauthorizedError",
    "ValidationError",
]


class NetProError(Exception):
    """Base class for every error NetPro raises on purpose."""

    #: Stable machine-readable code, rendered next to the message.
    code: str = "error"
    #: HTTP status the API layer maps this error to.
    status_code: int = 500

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        code: str | None = None,
        status_code: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Build an error from a message plus optional code, status, and headers."""
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = dict(details) if details else {}
        #: Extra response headers (`Retry-After`, `WWW-Authenticate`, ...).
        self.headers: dict[str, str] = dict(headers) if headers else {}
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code

    def to_payload(self) -> dict[str, Any]:
        """Render the frozen `{"error": ..., ...}` API envelope for this error."""
        payload: dict[str, Any] = {"error": self.message, **self.details}
        return payload


class NotFoundError(NetProError):
    """A referenced row does not exist, or is soft-deleted (`deleted_at`)."""

    code = "not_found"
    status_code = 404


class ValidationError(NetProError):
    """Input failed a domain rule. `details["fields"]` names the offenders."""

    code = "validation_failed"
    status_code = 422


class UnauthorizedError(NetProError):
    """No usable credential was presented (or it did not verify).

    Renders exactly the frozen 401 body:
    `{"error", "reason", "authMode", "hint"}`.
    """

    code = "unauthorized"
    status_code = 401

    def __init__(
        self,
        message: str = "Unauthorized",
        *,
        reason: str = "missing-credentials",
        auth_mode: str = "local",
        hint: str | None = None,
        token_configured: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        """Build the frozen 401 body (`reason`, `authMode`, `hint`)."""
        payload: dict[str, Any] = {"reason": reason, "authMode": auth_mode}
        if hint is not None:
            payload["hint"] = hint
        if details:
            payload.update(details)
        # The frozen contract advertises the scheme only when a token exists:
        # "Bearer" would be a lie on an install that has no token to offer.
        headers = {"WWW-Authenticate": 'Bearer realm="netpro"'} if token_configured else {}
        super().__init__(message, details=payload, headers=headers)


class ForbiddenError(NetProError):
    """Authenticated, but the workspace role does not allow the action."""

    code = "forbidden"
    status_code = 403


class ConflictError(NetProError):
    """The write conflicts with existing state (duplicate, wrong status, ...)."""

    code = "conflict"
    status_code = 409


class RateLimitedError(NetProError):
    """Per-IP budget exhausted. `details["retryAfterMs"]` mirrors the TS body."""

    code = "rate_limited"
    status_code = 429

    def __init__(
        self,
        message: str = "Too many requests.",
        *,
        retry_after_ms: int,
        details: dict[str, Any] | None = None,
    ) -> None:
        """Build the 429 body and its `Retry-After` header from one wait value."""
        payload: dict[str, Any] = {"retryAfterMs": retry_after_ms, **(details or {})}
        # `Retry-After` is in seconds; the body keeps the millisecond value the
        # TypeScript server sends.
        retry_after_seconds = max(1, -(-retry_after_ms // 1000))
        super().__init__(
            message,
            details=payload,
            headers={"Retry-After": str(retry_after_seconds)},
        )
        self.retry_after_ms = retry_after_ms


class ProviderUnavailableError(NetProError):
    """An optional BYO-key provider is missing, unreachable, or rejected us."""

    code = "provider_unavailable"
    status_code = 502


class ConfigError(NetProError):
    """Configuration is invalid. Loud by design: never fall back silently."""

    code = "invalid_config"
    status_code = 500


class LocalConfigError(ConfigError):
    """`~/.netpro/config.toml` (or an environment override) is invalid.

    Name-matched to the TypeScript `LocalConfigError` so migration-era code and
    messages line up across both implementations.
    """

    code = "invalid_local_config"
