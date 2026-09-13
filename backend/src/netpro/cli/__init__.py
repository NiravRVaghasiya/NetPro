"""CLI surface (migration Phase 13 — skeleton in Phase 1).

Typer commands. Every command delegates to the application layer — the CLI
owns parsing and presentation, never business rules, and must produce the
same results as the API for the same inputs.
"""

from __future__ import annotations

from netpro.cli.main import app

__all__ = ["app"]
