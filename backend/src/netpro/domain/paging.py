"""Pagination conventions: `limit` + `offset`, 25 by default, 100 at most.

The numbers are the frozen ones (`packages/core/src/crm/contacts.ts` clamps to
`[1, 100]`; the server route defaults `limit` to 25). Every list endpoint in
the Python API and every Python CLI list command must reuse these so a page of
results means the same thing on both sides of the migration.

Parsing is deliberately forgiving at the edge (a bad `?limit=abc` falls back to
the default, like the TypeScript `numParam` helper) and strict inside: the
returned `PageRequest` is always in range.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Generic, TypeVar

__all__ = [
    "DEFAULT_PAGE_LIMIT",
    "MAX_PAGE_LIMIT",
    "MIN_PAGE_LIMIT",
    "Page",
    "PageRequest",
]

#: Default page size for list endpoints and CLI listings.
DEFAULT_PAGE_LIMIT = 25

#: Hard ceiling — a local-first tool has no reason to serve 10k rows.
MAX_PAGE_LIMIT = 100

#: A page always holds at least one row.
MIN_PAGE_LIMIT = 1

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class PageRequest:
    """A validated `limit`/`offset` pair."""

    limit: int = DEFAULT_PAGE_LIMIT
    offset: int = 0

    def __post_init__(self) -> None:
        """Reject an out-of-range page rather than silently clamping it."""
        if self.limit < MIN_PAGE_LIMIT or self.limit > MAX_PAGE_LIMIT:
            msg = f"limit must be between {MIN_PAGE_LIMIT} and {MAX_PAGE_LIMIT}"
            raise ValueError(msg)
        if self.offset < 0:
            msg = "offset must not be negative"
            raise ValueError(msg)

    @property
    def next_offset(self) -> int:
        """The offset a caller would use for the following page."""
        return self.offset + self.limit

    @staticmethod
    def parse(limit: str | int | None = None, offset: str | int | None = None) -> PageRequest:
        """Build a request from raw query/CLI input, clamping into range.

        Unparseable values fall back to the defaults rather than erroring: this
        matches the TypeScript route helpers, where `?limit=abc` simply means
        "default page".
        """
        return PageRequest(
            limit=_clamp(_coerce(limit, DEFAULT_PAGE_LIMIT), MIN_PAGE_LIMIT, MAX_PAGE_LIMIT),
            offset=max(_coerce(offset, 0), 0),
        )


@dataclass(frozen=True, slots=True)
class Page(Generic[T]):
    """A page of results plus the metadata the API envelope repeats."""

    items: Sequence[T]
    total: int
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        """True when another page may follow."""
        return self.offset + len(self.items) < self.total

    def to_envelope(self, key: str, **extra: object) -> dict[str, object]:
        """Render `{"<key>": [...], "total", "limit", "offset", ...extra}`.

        The list key varies per endpoint (`contacts`, `jobs`, ...) but the
        surrounding metadata keys are fixed by the existing contract.
        """
        envelope: dict[str, object] = {
            key: list(self.items),
            "total": self.total,
            "limit": self.limit,
            "offset": self.offset,
        }
        envelope.update(extra)
        return envelope


def _coerce(value: str | int | None, fallback: int) -> int:
    if value is None:
        return fallback
    if isinstance(value, bool):  # bool is an int subclass; never a page size
        return fallback
    if isinstance(value, int):
        return value
    text = value.strip()
    if not text:
        return fallback
    try:
        return int(text)
    except ValueError:
        pass
    try:
        # `?limit=10.5` means 10, exactly as the TypeScript `Math.floor(Number(x))`
        # route helper treats it.
        return int(float(text))
    except ValueError:
        return fallback


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))
