"""GET /api/health — contract compatibility with the TS server's probe."""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from fastapi.testclient import TestClient

from netpro.api import create_app
from netpro.config import Settings

_TS_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class TestHealthBody:
    def test_envelope_matches_the_ts_shape(self, client: TestClient) -> None:
        response = client.get("/api/health")
        assert response.status_code == 200
        body = response.json()
        # Exactly the TS anonymous response fields — no extras, no renames.
        assert set(body) == {"status", "dialect", "latencyMs", "timestamp"}
        assert body["status"] == "healthy"
        assert body["dialect"] == "sqlite"
        assert isinstance(body["latencyMs"], int) and body["latencyMs"] >= 0

    def test_timestamp_is_js_iso8601_utc(self, client: TestClient) -> None:
        body = client.get("/api/health").json()
        assert _TS_TIMESTAMP.match(body["timestamp"])
        parsed = datetime.fromisoformat(body["timestamp"].replace("Z", "+00:00"))
        assert parsed.tzinfo is not None


class TestHealthHeaders:
    def test_json_with_no_store(self, client: TestClient) -> None:
        response = client.get("/api/health")
        assert response.headers["content-type"].startswith("application/json")
        assert response.headers["cache-control"] == "no-store, max-age=0"

    def test_request_id_assigned_when_absent(self, client: TestClient) -> None:
        response = client.get("/api/health")
        request_id = response.headers["x-request-id"]
        # Must be a UUID when the caller did not supply one.
        uuid.UUID(request_id)

    def test_incoming_request_id_is_reused(self, client: TestClient) -> None:
        response = client.get("/api/health", headers={"x-request-id": "my-correlation-1"})
        assert response.headers["x-request-id"] == "my-correlation-1"


class TestVerbose:
    def test_verbose_still_terse_in_phase_1(self, client: TestClient) -> None:
        # The TS ?verbose=1 extras (migrations, search) need the Phase 2
        # persistence layer; until then the envelope stays terse by design.
        body = client.get("/api/health", params={"verbose": "1"}).json()
        assert set(body) == {"status", "dialect", "latencyMs", "timestamp"}


class TestDialectReporting:
    def test_dialect_follows_db_dialect_setting(self) -> None:
        settings = Settings(db_dialect="postgresql")
        with TestClient(create_app(settings)) as client:
            body = client.get("/api/health").json()
        assert body["dialect"] == "postgresql"
