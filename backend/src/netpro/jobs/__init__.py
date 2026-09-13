"""Background jobs and event streaming (migration Phase 11).

Starts simple, per the plan: asyncio + database-backed job state + SSE — no
Redis/ARQ until a workload demands it. Job model: queued → running →
completed | failed, each with id, type, workspace, timestamps, progress,
error and result reference.

The SSE event names are a frozen contract with the web UI
(``use-netpro-events.ts``): ``contact.imported``, ``contact.updated``,
``graph.updated``, ``import.started/progress/completed``,
``enrichment.started/completed``, ``job.queued/running/progress/completed/
failed/cancelled`` — the browser must not notice that execution moved from
TypeScript to Python.
"""
