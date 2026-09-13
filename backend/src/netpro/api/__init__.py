"""HTTP API surface (migration Phase 12 — skeleton in Phase 1).

FastAPI application factory and route modules. Route handlers stay thin:
HTTP → auth/dependencies → application use case → domain → repository.
No business logic ever lives in a route file.
"""

from __future__ import annotations

from netpro.api.app import create_app

__all__ = ["create_app"]
