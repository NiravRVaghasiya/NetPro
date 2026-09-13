"""GET /api/health — readiness probe, contract-compatible with the TS server.

The TypeScript handler (``packages/server/src/routes/health.ts``) answers::

    {
      "status": "healthy" | "degraded" | "unhealthy",
      "dialect": "sqlite" | "postgresql",
      "latencyMs": 3,
      "timestamp": "2026-09-13T10:00:00.000Z"
    }

Anonymous responses are exactly that terse; ``?verbose=1`` adds migration
and search detail *for trusted local callers only*.

Phase 1 status of this port:

* The envelope, field names (camelCase ``latencyMs``), value domains and
  the ISO-8601 UTC timestamp format (milliseconds, ``Z``) match the TS
  contract exactly.
* ``status`` is ``healthy`` — the service is up. The database probe, the
  migration count check (``degraded`` + 503 when behind) and the verbose
  search report arrive with Phase 2's persistence layer, at which point
  this handler converges on the full TS behaviour.
* ``dialect`` reports the configured dialect (``DB_DIALECT``, default
  ``sqlite``) — the same value the TS handler would resolve for this
  environment.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from netpro.config import Settings

router = APIRouter(prefix="/api", tags=["health"])


class HealthResponse(BaseModel):
    """Body of GET /api/health — serialized with the TS field names."""

    model_config = ConfigDict(populate_by_name=True)

    status: Literal["healthy", "degraded", "unhealthy"]
    dialect: str
    latency_ms: Annotated[int, Field(serialization_alias="latencyMs", ge=0)]
    timestamp: str


def _utc_timestamp() -> str:
    """ISO-8601 UTC with milliseconds and a ``Z`` suffix — the JS shape."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    started = time.perf_counter()
    settings: Settings = request.app.state.settings
    return HealthResponse(
        status="healthy",
        dialect=settings.db_dialect,
        latency_ms=max(0, round((time.perf_counter() - started) * 1000)),
        timestamp=_utc_timestamp(),
    )
