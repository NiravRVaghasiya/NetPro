"""Structured errors: hierarchy behaviour and the HTTP mapping."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from netpro.api import create_app
from netpro.api.errors import install_error_handlers
from netpro.config import Settings
from netpro.errors import ConfigurationError, NetProError, NotFoundError


class TestHierarchy:
    def test_base_error_attributes(self) -> None:
        error = NetProError("something broke", details={"contact_id": "abc"})
        assert str(error) == "something broke"
        assert error.code == "netpro_error"
        assert error.http_status == 500
        assert error.details == {"contact_id": "abc"}

    def test_details_default_to_empty(self) -> None:
        assert NetProError("boom").details == {}

    def test_subclass_defaults(self) -> None:
        assert NotFoundError("gone").code == "not_found"
        assert NotFoundError("gone").http_status == 404
        assert ConfigurationError("bad config").http_status == 500


class TestHttpMapping:
    def _client(self) -> TestClient:
        """A throwaway app with a route that raises the error under test."""
        application = FastAPI()
        install_error_handlers(application)

        @application.get("/api/boom")
        def boom() -> None:
            raise NotFoundError('No person with id "xyz".')

        return TestClient(application, raise_server_exceptions=False)

    def test_netpro_error_becomes_the_ts_error_body(self) -> None:
        response = self._client().get("/api/boom")
        assert response.status_code == 404
        assert response.json() == {
            "error": 'No person with id "xyz".',
            "code": "not_found",
        }
        assert response.headers["cache-control"] == "no-store, max-age=0"

    def test_unknown_api_route_matches_the_ts_fallback_body(self) -> None:
        settings = Settings()
        with TestClient(create_app(settings)) as client:
            response = client.get("/api/does-not-exist")
        assert response.status_code == 404
        # The TS fallback sends error-only (no code): "Not found: GET /api/…".
        assert response.json() == {"error": "Not found: GET /api/does-not-exist"}

    def test_unknown_route_outside_api_is_fastapi_default(self) -> None:
        settings = Settings()
        with TestClient(create_app(settings)) as client:
            response = client.get("/nope")
        assert response.status_code == 404
