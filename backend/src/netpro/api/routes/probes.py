"""Public probes: `GET /api/health` (`/health`) and `GET /api/server-info`.

These are the only endpoints Phase 1 exposes, and they are public by design: a
readiness probe has to work before anyone holds a credential, and both bodies
are deliberately terse. Everything else in the frozen route table stays with
the TypeScript server until its Python replacement has golden-test parity.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from netpro.api.container import ApiContainer
from netpro.api.errors import NetProJSONResponse
from netpro.api.request_trust import resolve_trust
from netpro.application.health import HealthRequest

__all__ = ["router"]

router = APIRouter(tags=["probes"])


def container_of(request: Request) -> ApiContainer:
    """The container built at startup."""
    container: ApiContainer = request.app.state.container
    return container


@router.get("/api/health")
@router.get("/health")
async def health(
    request: Request,
    verbose: str | None = Query(default=None),
) -> Response:
    """Liveness/readiness. `?verbose` adds detail for the local operator only."""
    container = container_of(request)
    trust = resolve_trust(
        mode=container.settings.auth.mode,
        client_host=request.client.host if request.client else None,
        headers=request.headers,
    )
    outcome = await container.health_query.execute(
        HealthRequest(
            # `searchParams.has('verbose')` semantics: presence, not value.
            detail_requested=verbose is not None,
            detail_allowed=trust.trusted_local,
        )
    )
    return NetProJSONResponse(
        content=outcome.report.to_api_json(),
        status_code=outcome.status_code,
    )


@router.get("/api/server-info")
async def server_info(request: Request) -> Response:
    """Identity and auth posture, safe to read anonymously."""
    container = container_of(request)
    trust = resolve_trust(
        mode=container.settings.auth.mode,
        client_host=request.client.host if request.client else None,
        headers=request.headers,
    )
    identity = container.identity
    payload: dict[str, Any] = {
        "name": identity.name,
        "service": identity.service,
        "message": identity.message,
        "health": identity.health_path,
        "authMode": container.settings.auth.mode,
        "authenticationRequired": not trust.authenticated,
        "implementation": identity.implementation,
    }
    if identity.version:
        payload["version"] = identity.version
    return NetProJSONResponse(content=payload)
