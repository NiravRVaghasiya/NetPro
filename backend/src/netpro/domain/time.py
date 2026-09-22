"""Timezone policy: everything is UTC, serialised as ISO-8601 text.

Frozen by `docs/python-migration/migration-rules.md` §8: timestamps stay
**ISO-8601 text** on both dialects until an ADR says otherwise. Python must
therefore produce byte-identical strings to JavaScript's `Date.toISOString()`:

    2026-09-22T00:00:00.000Z

— UTC, seconds precision plus exactly three millisecond digits, `Z` suffix, no
offset arithmetic. Golden tests compare these strings against TypeScript
fixtures, so a `+00:00` suffix instead of `Z` is a contract break.

Internally, code works with timezone-aware `datetime` objects in UTC. A naive
`datetime` reaching `to_iso8601` is interpreted as UTC (that is what the stored
text means), never as local time.
"""

from __future__ import annotations

from datetime import UTC, datetime

__all__ = [
    "EPOCH_UTC",
    "now_utc",
    "parse_iso8601",
    "to_iso8601",
]

#: Midnight UTC on the Unix epoch; the "no timestamp yet" sentinel.
EPOCH_UTC = datetime(1970, 1, 1, tzinfo=UTC)


def now_utc() -> datetime:
    """The current time as a timezone-aware UTC `datetime`."""
    return datetime.now(UTC)


def to_iso8601(moment: datetime) -> str:
    """Serialise `moment` the way `Date.prototype.toISOString()` does.

    Naive values are read as UTC. Sub-millisecond precision is truncated, never
    rounded — matching JavaScript, whose `Date` cannot hold microseconds.
    """
    utc = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    utc = utc.astimezone(UTC)
    millis = utc.microsecond // 1000
    return (
        f"{utc.year:04d}-{utc.month:02d}-{utc.day:02d}"
        f"T{utc.hour:02d}:{utc.minute:02d}:{utc.second:02d}.{millis:03d}Z"
    )


def parse_iso8601(value: str) -> datetime:
    """Parse an ISO-8601 timestamp into an aware UTC `datetime`.

    Accepts the `Z` suffix NetPro writes and explicit offsets (which are
    converted to UTC). Raises `ValueError` on anything else — an unparseable
    timestamp is a data problem, not something to paper over.
    """
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = f"{text[:-1]}+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
