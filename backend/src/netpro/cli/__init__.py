"""Typer CLI. Phase 1 ships `version` and `serve`; the full surface is Phase 13.

`--json` output is the API payload, so scripts and the HTTP contract never
drift apart.
"""

from __future__ import annotations

from netpro.cli.app import app, main
from netpro.cli.output import emit

__all__ = ["app", "emit", "main"]
