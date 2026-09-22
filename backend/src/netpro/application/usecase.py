"""Use-case conventions: one operation, one implementation, many surfaces.

`NetPro_Python_First_Implementation_Plan.md` §2.2 forbids the same business rule
living in the web layer, the API layer, the CLI, and a Python module. Every
operation therefore has exactly one use case here; the FastAPI route, the Typer
command, and the job runner are thin adapters that construct a request and
render the result.

Conventions:

- A use case takes one typed request object and returns one typed result. No
  `**kwargs`, no framework types (`Request`, `Response`) below this layer.
- Sync use cases implement `UseCase`; anything that awaits I/O implements
  `AsyncUseCase` and is called from `asyncio` entry points (the API) or via
  `asyncio.run` (the CLI).
- Use cases raise `NetProError` subclasses. They never return status codes;
  mapping to HTTP happens in `netpro.api.errors`.
- A write use case receives an explicit `UnitOfWork` and uses
  `netpro.domain.ports.transaction` for its boundary.
"""

from __future__ import annotations

from typing import Protocol, TypeVar, runtime_checkable

__all__ = ["AsyncUseCase", "UseCase"]

_I = TypeVar("_I", contravariant=True)
_O = TypeVar("_O", covariant=True)


@runtime_checkable
class UseCase(Protocol[_I, _O]):
    """A synchronous operation."""

    def execute(self, request: _I) -> _O:
        """Run the operation for `request`."""
        ...


@runtime_checkable
class AsyncUseCase(Protocol[_I, _O]):
    """An operation that awaits I/O (database, providers, network)."""

    async def execute(self, request: _I) -> _O:
        """Run the operation for `request`."""
        ...
