"""Logging conventions for the Python platform (plan §26).

Rules that every future phase inherits:

* One ``configure_logging()`` call at process start (API server and CLI);
  libraries and modules only ``get_logger(__name__)``.
* Every request/job log line carries a request id and, where safe, the
  workspace id — via a ``ContextVar`` so async tasks and threads keep their
  own context without plumbing a parameter through every signature.
* Never log API keys, access tokens, raw credentials or unnecessary personal
  data. Phase 15 adds automated tests asserting this; the convention starts
  here so there is something to test.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar

#: Request/correlation id for the current task. ``None`` outside a request.
request_id_var: ContextVar[str | None] = ContextVar("netpro_request_id", default=None)

#: Workspace id for the current task, when one is known (and safe to log).
workspace_id_var: ContextVar[str | None] = ContextVar("netpro_workspace_id", default=None)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"


class _ContextFilter(logging.Filter):
    """Inject request/workspace context into every record, never crash.

    A missing context must not break logging: the filter renders ``-`` so
    log parsing stays line-shaped.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or "-"
        record.workspace_id = workspace_id_var.get() or "-"
        return True


def configure_logging(level: str = "INFO") -> None:
    """Idempotently configure root logging for a NetPro process.

    Uses stderr (survives systemd/docker/CLI usage where stdout is data),
    one line per event, request context attached. Calling it twice — e.g. in
    tests — must not duplicate handlers.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())

    if not any(
        isinstance(h, logging.StreamHandler) and getattr(h, "_netpro", False) for h in root.handlers
    ):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        handler.addFilter(_ContextFilter())
        # Marked so a second configure_logging() call reuses the handler
        # instead of stacking a duplicate one.
        handler._netpro = True  # type: ignore[attr-defined]  # marker attribute
        root.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    """Return a logger under the netpro namespace.

    ``get_logger("netpro.api")`` and ``__name__`` both work; the helper
    exists so no module ever configures the root logger itself.
    """
    return logging.getLogger(name if name.startswith("netpro") else f"netpro.{name}")
