"""Typed interfaces the layers agree on.

Ports live in the domain so that neither the application layer nor the API
imports an adapter. `netpro.infrastructure` implements them; tests substitute
fakes. The repository protocol is deliberately thin — per
`NetPro_Python_First_Implementation_Plan.md` §4, repositories are added *where
they provide value*, not as a blanket abstraction over every table.

Transaction boundaries are explicit: application code calls `transaction(uow)`
and never commits implicitly.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Protocol, TypeVar, runtime_checkable

from netpro.domain.scope import WorkspaceScope
from netpro.domain.time import now_utc

__all__ = [
    "Clock",
    "ReadRepository",
    "SystemClock",
    "UnitOfWork",
    "transaction",
]

T = TypeVar("T")

#: Covariant for read-only protocols: a `ReadRepository[Person]` may stand in
#: for a `ReadRepository[object]`, never the other way round.
T_co = TypeVar("T_co", covariant=True)


class Clock(Protocol):
    """Time source. Injectable so tests never depend on the wall clock."""

    def now(self) -> datetime:
        """The current time as a timezone-aware UTC `datetime`."""
        ...


class SystemClock:
    """The default `Clock`: the real wall clock, in UTC."""

    def now(self) -> datetime:
        """Return the current time as a timezone-aware UTC `datetime`."""
        return now_utc()


@runtime_checkable
class UnitOfWork(Protocol):
    """A transaction boundary around one or more repositories.

    Implementations (Phase 2: SQLAlchemy sessions) own the connection. The
    application layer only commits or rolls back.
    """

    def commit(self) -> None:
        """Persist everything done inside this unit of work."""
        ...

    def rollback(self) -> None:
        """Discard everything done inside this unit of work."""
        ...

    def close(self) -> None:
        """Release the underlying connection back to its pool."""
        ...


@runtime_checkable
class ReadRepository(Protocol[T_co]):
    """The read half of a repository: fetch one row inside a scope.

    Implementations must apply the workspace predicate themselves and must
    exclude soft-deleted rows (`deleted_at IS NOT NULL`) unless a phase says
    otherwise — the caller cannot widen the query.
    """

    def get(self, entity_id: str, *, scope: WorkspaceScope | None = None) -> T_co | None:
        """Return the row, or `None` when it is missing, deleted, or out of scope."""
        ...


@contextmanager
def transaction(uow: UnitOfWork) -> Iterator[UnitOfWork]:
    """Run a block inside one transaction: commit on success, roll back on error.

    ```python
    with transaction(uow):
        people.save(person, scope=scope)
        interactions.log(entry, scope=scope)
    ```

    The unit of work is always closed, so a connection leak cannot survive an
    exception in application code.
    """
    try:
        yield uow
    except BaseException:
        uow.rollback()
        raise
    else:
        try:
            uow.commit()
        except BaseException:
            # A rejected commit leaves the transaction open; the caller must
            # never be handed back a half-applied unit of work.
            uow.rollback()
            raise
    finally:
        uow.close()
