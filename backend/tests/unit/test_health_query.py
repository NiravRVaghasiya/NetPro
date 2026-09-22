from __future__ import annotations

from datetime import UTC, datetime

import pytest

from netpro.application.health import (
    HealthQuery,
    HealthRequest,
    MigrationState,
    ProbeResult,
    SearchCapability,
)


class FixedClock:
    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def now(self) -> datetime:
        return self._moment


class StubProbe:
    def __init__(self, result: ProbeResult | None = None, error: Exception | None = None) -> None:
        self._result = result or ProbeResult()
        self._error = error
        self.calls = 0

    async def check(self) -> ProbeResult:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._result


MOMENT = datetime(2026, 9, 22, 0, 0, 0, tzinfo=UTC)


def query(probe: StubProbe) -> HealthQuery:
    return HealthQuery(dialect="sqlite", probe=probe, clock=FixedClock(MOMENT))


async def test_a_healthy_install_reports_the_terse_contract_body() -> None:
    outcome = await query(StubProbe()).execute(HealthRequest())

    assert outcome.status_code == 200
    assert outcome.report.to_api_json() == {
        "status": "healthy",
        "dialect": "sqlite",
        "latencyMs": outcome.report.latency_ms,
        "timestamp": "2026-09-22T00:00:00.000Z",
    }
    assert set(outcome.report.to_api_json()) == {
        "status",
        "dialect",
        "latencyMs",
        "timestamp",
    }


async def test_verbose_detail_is_disclosed_only_to_the_operator() -> None:
    probe = StubProbe(
        ProbeResult(
            migrations=MigrationState(applied=15, expected=15),
            search=SearchCapability(mode="keyword", indexed=3, contacts=4, embedded=0),
        )
    )

    owner = await query(probe).execute(HealthRequest(detail_requested=True, detail_allowed=True))
    anonymous = await query(probe).execute(
        HealthRequest(detail_requested=True, detail_allowed=False)
    )
    unasked = await query(probe).execute(HealthRequest(detail_allowed=True))

    assert owner.report.to_api_json()["migrations"] == {"applied": 15, "expected": 15}
    assert owner.report.to_api_json()["search"] == {
        "mode": "keyword",
        "indexed": 3,
        "contacts": 4,
        "embedded": 0,
    }
    assert "migrations" not in anonymous.report.to_api_json()
    assert "migrations" not in unasked.report.to_api_json()


async def test_a_partially_migrated_schema_is_degraded() -> None:
    probe = StubProbe(ProbeResult(migrations=MigrationState(applied=14, expected=15)))

    owner = await query(probe).execute(HealthRequest(detail_requested=True, detail_allowed=True))
    anonymous = await query(probe).execute(HealthRequest())

    assert owner.status_code == 503
    assert owner.report.status == "degraded"
    assert owner.report.error == "Database migrations are not fully applied."
    assert owner.report.to_api_json()["migrations"] == {"applied": 14, "expected": 15}
    assert "migrations" not in anonymous.report.to_api_json()


async def test_an_unhealthy_probe_reports_503() -> None:
    probe = StubProbe(ProbeResult(healthy=False, error="disk on fire"))

    owner = await query(probe).execute(HealthRequest(detail_requested=True, detail_allowed=True))
    anonymous = await query(probe).execute(HealthRequest())

    assert owner.status_code == 503
    assert owner.report.error == "disk on fire"
    # A remote caller never learns the internals of the failure.
    assert anonymous.report.error == "Database is unavailable."


async def test_a_raising_probe_is_reported_not_propagated() -> None:
    probe = StubProbe(error=RuntimeError("connection refused"))

    owner = await query(probe).execute(HealthRequest(detail_requested=True, detail_allowed=True))

    assert owner.status_code == 503
    assert owner.report.status == "unhealthy"
    assert owner.report.error == "connection refused"


async def test_the_default_probe_performs_no_io() -> None:
    outcome = await HealthQuery(dialect="postgresql").execute(HealthRequest())

    assert outcome.report.status == "healthy"
    assert outcome.report.dialect == "postgresql"
    assert outcome.report.to_api_json()["latencyMs"] >= 0


async def test_latency_is_a_non_negative_integer() -> None:
    outcome = await query(StubProbe()).execute(HealthRequest())

    assert isinstance(outcome.report.latency_ms, int)
    assert outcome.report.latency_ms >= 0


@pytest.mark.parametrize("detail_requested", [True, False])
async def test_the_probe_is_called_exactly_once(detail_requested: bool) -> None:
    probe = StubProbe()

    await query(probe).execute(
        HealthRequest(detail_requested=detail_requested, detail_allowed=True)
    )

    assert probe.calls == 1
