"""Structured errors shared by every NetPro surface.

The TypeScript server answers failures with a two-key JSON body::

    {"error": "No scan job with id \"…\".", "code": "not_found"}

(see ``packages/server/src/routes/*`` and ``middleware/json.ts``). Keeping
that exact shape means the web UI's error handling keeps working when a
route's implementation moves from TypeScript to Python — the migration's
contract-first rule in practice.

This module defines the exception hierarchy; ``netpro/api/errors.py`` maps
it onto HTTP. The CLI renders the same ``code``/message pair as text so a
script can grep a stable machine code in either surface.
"""

from __future__ import annotations

from typing import Any


class NetProError(Exception):
    """Base class for every deliberate NetPro failure.

    Attributes:
        code: Stable, machine-readable identifier (snake_case). Never change
            a code after release — scripts and the web UI match on it.
        http_status: Status the API layer should use when this escapes to
            HTTP. Domain and application code never set statuses themselves.
        details: Optional structured context (ids, limits, field paths). Must
            never contain credentials or raw personal data — errors can end
            up in logs.
    """

    code = "netpro_error"
    http_status = 500

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}

    def __str__(self) -> str:
        return self.message


class ConfigurationError(NetProError):
    """Invalid configuration: a setting exists but its value is unusable.

    Mirrors the TS posture (``LocalConfigError``): configuration mistakes are
    loud, never silently fallen back to defaults — a typo in an auth mode or
    port must stop the process, not strand the user on a default they believe
    they changed.
    """

    code = "configuration_error"
    http_status = 500


class ValidationError(NetProError):
    """Input failed validation (client's fault, 4xx)."""

    code = "invalid_request"
    http_status = 400


class NotFoundError(NetProError):
    """A referenced entity does not exist in this workspace."""

    code = "not_found"
    http_status = 404
