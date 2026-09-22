"""NetPro — local-first professional relationship intelligence, in Python.

This package is the **Python foundation** (migration Phase 1). It contains the
conventions every later phase builds on and nothing else: no product capability
has moved out of the TypeScript `@netpro/core` yet, and the TypeScript product
remains the shipped one.

Layout (see `docs/adr/0002-python-api-and-data-stack.md`):

- `netpro.config`        install layout, `config.toml` subset, settings
- `netpro.domain`        value objects, errors, identity/time/paging/scope rules
- `netpro.application`   use cases (Phase 1: health)
- `netpro.intelligence`  graph + search (Phases 4–5)
- `netpro.integrations`  LinkedIn, AI, enrichment, content (Phases 6–8)
- `netpro.infrastructure`logging, persistence, and other adapters
- `netpro.api`           FastAPI surface preserving the frozen HTTP contract
- `netpro.cli`           Typer surface (full command set is Phase 13)
- `netpro.jobs`          job/event contract names (Phase 11 implements them)
"""

from __future__ import annotations

__version__ = "0.1.0"

#: The TypeScript product version this Python tree is migrating from.
#: Every contract fixture under `docs/python-migration/fixtures/` was captured
#: against it, so golden tests compare against a named, frozen baseline.
PRODUCT_BASELINE = "3.0.2"

__all__ = ["PRODUCT_BASELINE", "__version__"]
