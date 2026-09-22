"""HTTP API — the frozen contract, served by Python.

Phase 1 exposes the two public probes. The rest of the route table
(`docs/python-migration/api-contracts.md`) migrates in Phases 11–12, once the
jobs/SSE transport and the domain services behind those routes exist in
Python.
"""

from __future__ import annotations

from netpro.api.app import create_app
from netpro.api.container import ApiContainer, ServerIdentity, build_container
from netpro.api.errors import (
    CACHE_CONTROL,
    JSON_MEDIA_TYPE,
    NetProJSONResponse,
    error_response,
    install_exception_handlers,
)
from netpro.api.middleware import (
    HSTS_HEADER_VALUE,
    REQUEST_ID_HEADER,
    NetProHeadersMiddleware,
    request_id_of,
)
from netpro.api.request_trust import (
    PROXY_HEADERS,
    RequestTrust,
    is_direct_loopback_request,
    is_loopback_address,
    resolve_trust,
)

__all__ = [
    "CACHE_CONTROL",
    "HSTS_HEADER_VALUE",
    "JSON_MEDIA_TYPE",
    "PROXY_HEADERS",
    "REQUEST_ID_HEADER",
    "ApiContainer",
    "NetProHeadersMiddleware",
    "NetProJSONResponse",
    "RequestTrust",
    "ServerIdentity",
    "build_container",
    "create_app",
    "error_response",
    "install_exception_handlers",
    "is_direct_loopback_request",
    "is_loopback_address",
    "request_id_of",
    "resolve_trust",
]
