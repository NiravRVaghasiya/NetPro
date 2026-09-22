"""Infrastructure adapters: logging today, persistence and providers later.

Everything here implements a port declared in `netpro.domain.ports`. The
application layer never imports this package directly — the API container wires
the two together.
"""

from __future__ import annotations

from netpro.infrastructure.logging import (
    REDACTED,
    RedactingFilter,
    configure_logging,
    get_logger,
    redact,
)

__all__ = ["REDACTED", "RedactingFilter", "configure_logging", "get_logger", "redact"]
