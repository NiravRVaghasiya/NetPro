"""CLI output convention: `--json` prints exactly what the API returns.

`docs/python-migration/migration-rules.md` §2 freezes this: a CLI `--json`
payload is the same object the HTTP endpoint serves, so a script can switch
from shelling out to calling the API without re-parsing anything. Human output
is a rendering of that same dict, never a parallel data structure.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

import typer

__all__ = ["emit"]


def emit(
    payload: Mapping[str, Any],
    *,
    as_json: bool,
    human: Callable[[Mapping[str, Any]], str],
    err: bool = False,
) -> None:
    """Print `payload` as JSON, or as the human rendering of the same data."""
    if as_json:
        typer.echo(json.dumps(dict(payload), indent=2, ensure_ascii=False), err=err)
    else:
        typer.echo(human(payload), err=err)
