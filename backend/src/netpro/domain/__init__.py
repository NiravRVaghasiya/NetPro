"""Domain layer: NetPro's business vocabulary, with no framework imports.

Phase 1 provides the *conventions* later phases build on — errors, ids,
timestamps, workspace scope, pagination, and the ports the infrastructure
implements. Domain objects themselves (Person, Relationship, Interaction, ...)
arrive in migration Phase 3.
"""

from __future__ import annotations

from netpro.domain.errors import (
    ConfigError,
    ConflictError,
    ForbiddenError,
    LocalConfigError,
    NetProError,
    NotFoundError,
    ProviderUnavailableError,
    RateLimitedError,
    UnauthorizedError,
    ValidationError,
)
from netpro.domain.ids import (
    ACCESS_TOKEN_PREFIX,
    INSTALLATION_ID_PREFIX,
    is_access_token,
    is_row_id,
    mask_secret,
    new_access_token,
    new_id,
    new_installation_id,
)
from netpro.domain.paging import (
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    Page,
    PageRequest,
)
from netpro.domain.ports import Clock, ReadRepository, SystemClock, UnitOfWork, transaction
from netpro.domain.scope import (
    BOOTSTRAP_WORKSPACE_ID,
    ROLE_RANK,
    SYSTEM_USER_ID,
    WorkspaceRole,
    WorkspaceScope,
    bootstrap_scope,
    resolve_scope,
)
from netpro.domain.time import now_utc, parse_iso8601, to_iso8601

__all__ = [
    "ACCESS_TOKEN_PREFIX",
    "BOOTSTRAP_WORKSPACE_ID",
    "DEFAULT_PAGE_LIMIT",
    "INSTALLATION_ID_PREFIX",
    "MAX_PAGE_LIMIT",
    "ROLE_RANK",
    "SYSTEM_USER_ID",
    "Clock",
    "ConfigError",
    "ConflictError",
    "ForbiddenError",
    "LocalConfigError",
    "NetProError",
    "NotFoundError",
    "Page",
    "PageRequest",
    "ProviderUnavailableError",
    "RateLimitedError",
    "ReadRepository",
    "SystemClock",
    "UnauthorizedError",
    "UnitOfWork",
    "ValidationError",
    "WorkspaceRole",
    "WorkspaceScope",
    "bootstrap_scope",
    "is_access_token",
    "is_row_id",
    "mask_secret",
    "new_access_token",
    "new_id",
    "new_installation_id",
    "now_utc",
    "parse_iso8601",
    "resolve_scope",
    "to_iso8601",
    "transaction",
]
