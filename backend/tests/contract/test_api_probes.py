"""Contract tests: the Python API must answer like the TypeScript server.

Every expectation here is anchored to something frozen in Phase 0 —
`docs/python-migration/api-contracts.md` or a captured fixture — not to what
the Python code happens to do.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from netpro.api import (
    CACHE_CONTROL,
    JSON_MEDIA_TYPE,
    build_container,
    create_app,
    install_exception_handlers,
)
from netpro.application.health import MigrationState, ProbeResult, SearchCapability
from netpro.config import Settings
from netpro.domain.errors import UnauthorizedError

ISO_8601_MILLIS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class StubProbe:
    def __init__(self, result: ProbeResult) -> None:
        self._result = result

    async def check(self) -> ProbeResult:
        return self._result


@pytest.mark.contract
async def test_health_body_matches_the_frozen_fixture(
    client: httpx.AsyncClient, load_fixture: Callable[[str], Any]
) -> None:
    fixture = load_fixture("api/health.json")

    response = await client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == set(fixture)
    assert body["status"] == fixture["status"] == "healthy"
    assert body["dialect"] == fixture["dialect"] == "sqlite"
    assert isinstance(body["latencyMs"], int)
    assert ISO_8601_MILLIS.match(body["timestamp"]), body["timestamp"]


@pytest.mark.contract
async def test_json_transport_headers_match_the_contract(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health")

    assert response.headers["content-type"] == JSON_MEDIA_TYPE
    assert response.headers["cache-control"] == CACHE_CONTROL
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "strict-transport-security" not in response.headers


async def test_hsts_is_sent_only_when_the_operator_opted_in(settings: Settings) -> None:
    hardened = settings.model_copy(
        update={"server": settings.server.model_copy(update={"hsts": True})}
    )
    app = create_app(build_container(hardened, version="test"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://netpro.test") as http:
        response = await http.get("/api/health")

    assert response.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"


async def test_the_health_alias_is_served_too(client: httpx.AsyncClient) -> None:
    assert (await client.get("/health")).status_code == 200


async def test_request_id_is_generated_echoed_and_capped(client: httpx.AsyncClient) -> None:
    generated = await client.get("/api/health")
    assert generated.headers["x-request-id"]

    echoed = await client.get("/api/health", headers={"X-Request-Id": "trace-123"})
    assert echoed.headers["x-request-id"] == "trace-123"

    capped = await client.get("/api/health", headers={"X-Request-Id": "x" * 200})
    assert capped.headers["x-request-id"] == "x" * 128


@pytest.mark.contract
async def test_server_info_matches_the_frozen_fixture(
    client: httpx.AsyncClient, load_fixture: Callable[[str], Any]
) -> None:
    fixture = load_fixture("api/server-info.json")

    response = await client.get("/api/server-info")

    assert response.status_code == 200
    body = response.json()
    for key, value in fixture.items():
        assert body[key] == value, key
    # The only addition is an honest marker of which implementation answered.
    assert set(body) - set(fixture) == {"implementation", "version"}
    assert body["implementation"] == "python"


async def test_server_info_reports_auth_posture_for_a_remote_caller(
    remote_client: Callable[..., httpx.AsyncClient],
) -> None:
    async with remote_client() as http:
        body = (await http.get("/api/server-info")).json()

    assert body["authMode"] == "local"
    assert body["authenticationRequired"] is True


async def test_verbose_health_gates_detail_to_the_local_operator(settings: Settings) -> None:
    probe = StubProbe(
        ProbeResult(
            migrations=MigrationState(applied=15, expected=15),
            search=SearchCapability(mode="portable", indexed=0, contacts=0, embedded=0),
        )
    )
    app = create_app(build_container(settings, health_probe=probe, version="test"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://netpro.test") as http:
        owner = (await http.get("/api/health?verbose=1")).json()
        proxied = (
            await http.get("/api/health?verbose=1", headers={"X-Forwarded-For": "203.0.113.9"})
        ).json()
        plain = (await http.get("/api/health")).json()

    assert owner["migrations"] == {"applied": 15, "expected": 15}
    assert owner["search"]["mode"] == "portable"
    assert "migrations" not in proxied
    assert "migrations" not in plain


@pytest.mark.contract
async def test_unknown_api_path_is_a_json_404(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/does-not-exist")

    assert response.status_code == 404
    assert response.json() == {"error": "Not found: GET /api/does-not-exist"}
    assert response.headers["content-type"] == JSON_MEDIA_TYPE


@pytest.mark.contract
async def test_a_wrong_method_on_a_known_path_is_a_404_not_a_405(
    client: httpx.AsyncClient,
) -> None:
    # The TS router matches method+path together, so it never emits 405.
    response = await client.post("/api/health")

    assert response.status_code == 404
    assert response.json() == {"error": "Not found: POST /api/health"}


@pytest.mark.contract
async def test_unknown_non_api_path_uses_the_short_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get("/nope")

    assert response.status_code == 404
    assert response.json() == {"error": "Not found"}


async def test_interactive_docs_are_not_served(client: httpx.AsyncClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert (await client.get(path)).status_code == 404


@pytest.mark.contract
async def test_the_401_body_matches_the_frozen_fixture(
    load_fixture: Callable[[str], Any],
) -> None:
    fixture = load_fixture("api/unauthorized.json")
    app = FastAPI()
    install_exception_handlers(app)

    @app.get("/api/identity")
    async def identity() -> None:
        raise UnauthorizedError(
            reason="missing-credentials",
            auth_mode="token",
            hint=fixture["hint"],
            token_configured=True,
        )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://netpro.test") as http:
        response = await http.get("/api/identity")

    assert response.status_code == 401
    assert response.json() == fixture
    assert response.headers["www-authenticate"] == 'Bearer realm="netpro"'


@pytest.mark.contract
async def test_an_unhandled_error_uses_the_typescript_500_envelope() -> None:
    app = FastAPI()
    install_exception_handlers(app)

    @app.get("/api/boom")
    async def boom() -> None:
        raise RuntimeError("kaboom")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://netpro.test") as http:
        response = await http.get("/api/boom")

    assert response.status_code == 500
    assert response.json() == {"error": "Internal server error", "message": "kaboom"}
