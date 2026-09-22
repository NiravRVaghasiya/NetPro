"""Jobs and the SSE event stream.

Phase 1 freezes the **names** (`netpro.jobs.contract`); Phase 11 implements the
registry and the transport. Until then the TypeScript server owns jobs, and the
Python side must not publish a differently-named event or a differently-shaped
job payload.
"""

from __future__ import annotations

from netpro.jobs.contract import (
    EVENT_TYPES,
    JOB_STATUSES,
    JOB_TYPES,
    JobStatus,
    JobType,
    is_event_type,
    job_timestamp_aliases,
    job_timestamp_fields,
)

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
