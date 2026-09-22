"""Cross-language contract guard: the job/event vocabulary must not drift.

These tests read the TypeScript source and the Phase 0 fixture directly, so
renaming an event in either implementation fails the other one's suite. That is
the point: `docs/python-migration/migration-rules.md` §12 says persistence is
optional and changing event names is not.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from netpro.jobs import (
    EVENT_TYPES,
    JOB_STATUSES,
    JOB_TYPES,
    is_event_type,
    job_timestamp_aliases,
)


def ts_string_array(path: Path, name: str) -> tuple[str, ...]:
    body = path.read_text(encoding="utf-8")
    match = re.search(rf"export const {name}[^=]*=\s*\[(.*?)\]", body, re.DOTALL)
    assert match is not None, f"could not find {name} in {path}"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


@pytest.mark.contract
def test_event_types_match_the_typescript_bus(repo_root: Path) -> None:
    source = repo_root / "packages" / "server" / "src" / "events" / "index.ts"

    assert ts_string_array(source, "EVENT_TYPES") == EVENT_TYPES


@pytest.mark.contract
def test_job_types_and_statuses_match_the_typescript_registry(repo_root: Path) -> None:
    source = repo_root / "packages" / "server" / "src" / "jobs" / "index.ts"

    assert ts_string_array(source, "JOB_TYPES") == JOB_TYPES
    assert ts_string_array(source, "JOB_STATUSES") == JOB_STATUSES


def test_is_event_type_only_accepts_canonical_names() -> None:
    assert is_event_type("job.queued") is True
    assert is_event_type("job.paused") is False


@pytest.mark.contract
def test_every_key_in_the_job_fixture_is_a_known_field_or_alias(
    load_fixture: Callable[[str], Any],
) -> None:
    job = load_fixture("api/job.json")
    aliases = job_timestamp_aliases()
    known = {
        "id",
        "type",
        "status",
        "progress",
        "error",
        "metadata",
        *aliases,
        *aliases.values(),
    }

    unknown = set(job) - known
    assert unknown == set(), f"job fixture has keys Python does not know: {unknown}"

    # Both spellings must be present for every timestamp TypeScript emitted.
    for camel, snake_case in aliases.items():
        if camel in job:
            assert job[snake_case] == job[camel]


def test_the_fixture_uses_only_canonical_types_and_statuses(
    load_fixture: Callable[[str], Any],
) -> None:
    job = load_fixture("api/job.json")

    assert job["type"] in JOB_TYPES
    assert job["status"] in JOB_STATUSES
    assert 0 <= job["progress"] <= 100
