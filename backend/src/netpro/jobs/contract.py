"""Job and event **names** — frozen contract, implementation in Phase 11.

The Web UI and the TypeScript CLI already depend on these strings: job types,
job statuses, the camelCase *and* snake_case timestamp aliases in job JSON, and
the SSE event names the Activity page filters on. `docs/python-migration/
migration-rules.md` §12 is explicit: persistence is optional, **changing event
names is not**.

Phase 1 therefore freezes the vocabulary (and tests it against the captured
fixture) without implementing a registry. Phase 11 builds the registry and the
SSE transport on top of exactly these values.
"""

from __future__ import annotations

from typing import Final, Literal

__all__ = [
    "EVENT_TYPES",
    "JOB_STATUSES",
    "JOB_TYPES",
    "JobStatus",
    "JobType",
    "is_event_type",
    "job_timestamp_aliases",
    "job_timestamp_fields",
]

#: The seven job types the UI can render.
JOB_TYPES: Final[tuple[str, ...]] = (
    "import",
    "scan",
    "enrich",
    "index",
    "embed",
    "graph",
    "analyze",
)

#: Job lifecycle: `queued → running → completed | failed | cancelled`.
JOB_STATUSES: Final[tuple[str, ...]] = (
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
)

#: Canonical SSE event names (`EVENT_TYPES` in `packages/server/src/events`).
EVENT_TYPES: Final[tuple[str, ...]] = (
    "job.queued",
    "job.running",
    "job.progress",
    "job.completed",
    "job.failed",
    "job.cancelled",
    "scan.started",
    "scan.progress",
    "scan.completed",
    "contact.imported",
    "contact.updated",
    "relationship.discovered",
    "relationship.updated",
    "graph.updated",
    "search.started",
    "search.completed",
    "enrichment.started",
    "enrichment.completed",
    "import.started",
    "import.progress",
    "import.completed",
)

JobType = Literal["import", "scan", "enrich", "index", "embed", "graph", "analyze"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


def is_event_type(value: str) -> bool:
    """True when `value` is a canonical NetPro event name."""
    return value in EVENT_TYPES


def job_timestamp_fields() -> tuple[str, ...]:
    """The camelCase timestamp fields a job payload carries."""
    return ("startedAt", "completedAt", "createdAt", "updatedAt")


def job_timestamp_aliases() -> dict[str, str]:
    """CamelCase → snake_case timestamp aliases.

    Both spellings are emitted for every timestamp so the existing TypeScript
    consumers (`apps/web`, `apps/cli/src/lib/jobs.ts`) and any new Python
    consumer read the same payload without an adapter.
    """
    return {
        "startedAt": "started_at",
        "completedAt": "completed_at",
        "createdAt": "created_at",
        "updatedAt": "updated_at",
    }
