"""Structured logging with credential redaction.

NetPro is local-first and has no telemetry, so the log is the operator's only
window into what happened. Two rules make it trustworthy:

1. **Structure.** One JSON object per record with a stable set of keys
   (`timestamp`, `level`, `logger`, `message`, plus `request_id` when the call
   came through the API). Grep and `jq` are the observability stack.
2. **No secrets.** Access tokens (`np_…`) and provider keys (`sk-…`) are
   replaced by `***redacted***` on the way out. This is a backstop, not a
   licence to log credentials: `docs/python-migration/migration-rules.md` §10
   still requires that no code path puts a raw key in a response, a log, or an
   exception message.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Mapping
from typing import Any

__all__ = [
    "REDACTED",
    "RedactingFilter",
    "configure_logging",
    "get_logger",
    "redact",
]

#: Replacement for anything that looks like a credential.
REDACTED = "***redacted***"

#: Credential shapes NetPro mints or accepts. Deliberately narrow: a broad
#: pattern would eat ordinary prose and hide the real message.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Local access tokens: np_ + 43 base64url characters.
    re.compile(r"\bnp_[A-Za-z0-9_-]{16,}\b"),
    # OpenAI-style provider keys.
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    # Hunter / Clearbit / PDL style keys (long opaque tokens).
    re.compile(r"\b(?:hunter|clearbit|pdl)_[A-Za-z0-9]{16,}\b", re.IGNORECASE),
)


def redact(text: str) -> str:
    """Replace anything that looks like a credential with `REDACTED`."""
    result = text
    for pattern in _SECRET_PATTERNS:
        result = pattern.sub(REDACTED, result)
    return result


class RedactingFilter(logging.Filter):
    """Scrub credentials out of a record before any handler formats it."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Redact `record.msg` (and its args) in place. Always returns True."""
        message = record.msg if isinstance(record.msg, str) else str(record.msg)
        if record.args:
            try:
                message = message % record.args
            except (TypeError, ValueError):
                message = f"{message} {record.args!r}"
            record.args = None
        record.msg = redact(message)
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with a stable key order."""

    _RESERVED = frozenset(
        {
            "args",
            "asctime",
            "created",
            "exc_info",
            "exc_text",
            "filename",
            "funcName",
            "levelname",
            "levelno",
            "lineno",
            "module",
            "msecs",
            "message",
            "msg",
            "name",
            "pathname",
            "process",
            "processName",
            "relativeCreated",
            "stack_info",
            "taskName",
            "thread",
            "threadName",
        }
    )

    def format(self, record: logging.LogRecord) -> str:
        """Render the record as a single-line JSON object."""
        payload: dict[str, Any] = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in self._RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=True)


def get_logger(name: str) -> logging.Logger:
    """A child of the `netpro` logger."""
    return logging.getLogger(name if name.startswith("netpro") else f"netpro.{name}")


def configure_logging(
    *,
    level: int | str = "INFO",
    json_output: bool = True,
    stream: Any = None,
) -> logging.Logger:
    """Install the NetPro handler on the `netpro` logger. Idempotent.

    Returns the root `netpro` logger so callers can keep going:
    `log = configure_logging(level="DEBUG")`.
    """
    logger = logging.getLogger("netpro")
    logger.setLevel(level)
    logger.propagate = False

    for handler in list(logger.handlers):
        logger.removeHandler(handler)

    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(
        JsonFormatter() if json_output else logging.Formatter("%(levelname)s %(name)s: %(message)s")
    )
    handler.addFilter(RedactingFilter())
    logger.addHandler(handler)
    return logger


def structured_extra(**fields: Any) -> Mapping[str, Any]:
    """Build the `extra=` mapping for a structured log call.

    ```python
    log.info("job finished", extra=structured_extra(request_id=rid, job_id=jid))
    ```
    """
    return {key: value for key, value in fields.items() if key not in JsonFormatter._RESERVED}
