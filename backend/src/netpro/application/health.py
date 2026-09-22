"""`GET /api/health` — the one use case Phase 1 implements.

The health body is a frozen contract (`docs/python-migration/fixtures/api/
health.json`): `{status, dialect, latencyMs, timestamp}`, extended with
`migrations` and `search` only when the caller asked for `?verbose` **and** is
the local operator. The Python implementation reproduces that rule exactly.

What Phase 1 does *not* do yet: talk to the database. The default probe
(`LatencyHealthProbe`) performs no I/O, so a Phase 1 health response reports
the *configured* dialect and the probe latency, and never claims the schema is
applied. Phase 2 installs a `DatabaseHealthProbe` that runs `SELECT 1`, counts
applied migrations, and reports search-index status — the status rules below
already handle those results, including the `degraded`/503 path for a schema
that is not fully migrated.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from netpro.application.usecase import AsyncUseCase
from netpro.domain.ports import Clock, SystemClock
from netpro.domain.time import to_iso8601

__all__ = [
    "HealthOutcome",
    "HealthProbe",
    "HealthQuery",
    "HealthReport",
    "HealthRequest",
    "HealthStatus",
    "LatencyHealthProbe",
    "MigrationState",
    "ProbeResult",
    "SearchCapability",
    "SearchMode",
]

HealthStatus = Literal["healthy", "degraded", "unhealthy"]
SearchMode = Literal["portable", "keyword", "hybrid"]

_DEGRADED_SCHEMA = "Database migrations are not fully applied."
_UNAVAILABLE = "Database is unavailable."


class MigrationState(BaseModel):
    """Applied vs expected migration counts."""

    model_config = ConfigDict(frozen=True)

    applied: int
    expected: int


class SearchCapability(BaseModel):
    """Search index status, as the health body reports it."""

    model_config = ConfigDict(frozen=True)

    mode: SearchMode
    indexed: int
    contacts: int
    embedded: int


class HealthReport(BaseModel):
    """The `/api/health` body. Field order matches the TypeScript payload."""

    model_config = ConfigDict(populate_by_name=True)

    status: HealthStatus
    dialect: str
    latency_ms: int = Field(alias="latencyMs")
    timestamp: str
    migrations: MigrationState | None = None
    search: SearchCapability | None = None
    error: str | None = None

    def to_api_json(self) -> dict[str, Any]:
        """Render the payload, omitting the keys TypeScript leaves undefined."""
        return self.model_dump(by_alias=True, exclude_none=True)


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """What a `HealthProbe` found. `healthy=False` implies `error`."""

    healthy: bool = True
    migrations: MigrationState | None = None
    search: SearchCapability | None = None
    error: str | None = None


class HealthProbe(Protocol):
    """The dependency check behind `/api/health`.

    Implementations must be fast and side-effect free: this runs on every
    probe, including the ones a container runtime makes once a second.
    """

    async def check(self) -> ProbeResult:
        """Inspect the dependency and report what was found."""
        ...


class LatencyHealthProbe:
    """The Phase 1 probe: no I/O, always healthy.

    It exists so the endpoint, its contract, and its tests are real while the
    persistence layer is still TypeScript. Phase 2 replaces it with a probe
    that runs `SELECT 1` and counts migrations.
    """

    async def check(self) -> ProbeResult:
        """Report "nothing to check" — no database I/O is performed."""
        return ProbeResult()


@dataclass(frozen=True, slots=True)
class HealthRequest:
    """What the caller asked for."""

    #: The request carried `?verbose` (any value, including empty).
    detail_requested: bool = False
    #: The caller is the local operator, so detail may be disclosed.
    detail_allowed: bool = False


@dataclass(frozen=True, slots=True)
class HealthOutcome:
    """The report plus the HTTP status it must be served with."""

    report: HealthReport
    status_code: int


class HealthQuery:
    """Answer "is this install healthy?" for the API and the CLI alike."""

    def __init__(
        self,
        *,
        dialect: str,
        probe: HealthProbe | None = None,
        clock: Clock | None = None,
    ) -> None:
        """Bind the use case to a dialect, a probe, and a clock."""
        self._dialect = dialect
        self._probe: HealthProbe = probe if probe is not None else LatencyHealthProbe()
        self._clock: Clock = clock if clock is not None else SystemClock()

    async def execute(self, request: HealthRequest) -> HealthOutcome:
        """Probe, apply the status rules, and gate detail to the operator."""
        disclose = request.detail_requested and request.detail_allowed
        started = time.perf_counter()
        try:
            result = await self._probe.check()
        except Exception as error:  # a probe failure is a result, not a crash
            latency = _elapsed_ms(started)
            return HealthOutcome(
                report=HealthReport(
                    status="unhealthy",
                    dialect=self._dialect,
                    latency_ms=latency,
                    timestamp=to_iso8601(self._clock.now()),
                    error=str(error) if disclose else _UNAVAILABLE,
                ),
                status_code=503,
            )
        latency = _elapsed_ms(started)

        migrations = result.migrations
        if migrations is not None and migrations.applied < migrations.expected:
            return HealthOutcome(
                report=HealthReport(
                    status="degraded",
                    dialect=self._dialect,
                    latency_ms=latency,
                    timestamp=to_iso8601(self._clock.now()),
                    migrations=migrations if disclose else None,
                    error=_DEGRADED_SCHEMA,
                ),
                status_code=503,
            )

        if not result.healthy:
            return HealthOutcome(
                report=HealthReport(
                    status="degraded",
                    dialect=self._dialect,
                    latency_ms=latency,
                    timestamp=to_iso8601(self._clock.now()),
                    migrations=migrations if disclose else None,
                    error=(result.error or _UNAVAILABLE) if disclose else _UNAVAILABLE,
                ),
                status_code=503,
            )

        return HealthOutcome(
            report=HealthReport(
                status="healthy",
                dialect=self._dialect,
                latency_ms=latency,
                timestamp=to_iso8601(self._clock.now()),
                migrations=migrations if disclose else None,
                search=result.search if disclose else None,
            ),
            status_code=200,
        )


if TYPE_CHECKING:
    # Compile-time proof that `HealthQuery` satisfies the use-case protocol.
    _health_query_is_a_use_case: AsyncUseCase[HealthRequest, HealthOutcome] = HealthQuery(
        dialect="sqlite"
    )


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
