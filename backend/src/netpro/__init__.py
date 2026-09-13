"""NetPro — local-first professional relationship intelligence.

Python implementation of the NetPro platform, grown phase by phase from
``NetPro_Python_First_Implementation_Plan.md``. The TypeScript packages under
``packages/`` and ``apps/`` remain authoritative until each Python phase
reaches parity; this package is the destination, not yet the source of truth.

Layout (one module per future phase):

* ``netpro.config``      — settings, resolved like the TS ``@netpro/db`` /
  ``@netpro/server`` configuration (env first, then config file, then
  local-first defaults).
* ``netpro.errors``      — the structured error hierarchy shared by the API,
  CLI and future jobs so failures carry a machine-readable code, not just a
  message.
* ``netpro.observability`` — logging conventions (request ids, structured
  context, never secrets).
* ``netpro.domain``      — business rules (Phase 3): scoring, follow-ups,
  dedupe identity, workspace ownership.
* ``netpro.intelligence`` — graph, search and ranking engines (Phases 4-5),
  the first major migrations because Python's ecosystem is strongest there.
* ``netpro.integrations`` — LinkedIn import, enrichment, AI providers,
  embeddings (Phases 6-8), behind explicit provider interfaces.
* ``netpro.infrastructure`` — persistence and everything mechanical
  (Phase 2: SQLAlchemy models over the *existing* schema).
* ``netpro.application`` — use cases composing domain + infrastructure; the
  single place a business rule may live (one rule, one implementation).
* ``netpro.api``         — FastAPI routes; thin, no business logic.
* ``netpro.cli``         — Typer commands calling the same use cases.
* ``netpro.jobs``        — background work + SSE semantics (Phase 11).
"""

from __future__ import annotations

# Product version — pinned to the workspace version in the root package.json
# so `netpro --version`, the API banner and the npm release all agree. The
# TypeScript CLI pins these together the same way (apps/cli/src/bundle.test.ts).
__version__ = "3.0.2"

__all__ = ["__version__"]
