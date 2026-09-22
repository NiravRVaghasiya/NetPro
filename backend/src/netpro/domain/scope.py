"""Workspace scope — the tenant predicate every query carries.

Ported from `packages/core/src/workspaces/scope.ts`. The v2.5 compatibility
guarantee is preserved: an un-scoped caller resolves to the **bootstrap
workspace** (`default`) as the synthetic `system` user, so a single-owner
install behaves exactly as it did before tenancy existed.

Scoping is enforced in the domain, never trusted to a caller: a surface (CLI,
API, UI) may only supply a scope that an authenticating layer already resolved.
There is no path for an external request to widen a query by passing a
`workspace_id`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

__all__ = [
    "BOOTSTRAP_WORKSPACE_ID",
    "ROLE_RANK",
    "SYSTEM_USER_ID",
    "WorkspaceRole",
    "WorkspaceScope",
    "bootstrap_scope",
    "resolve_scope",
]

#: The workspace a fresh install is migrated into; every bootstrap row lives here.
BOOTSTRAP_WORKSPACE_ID: Final = "default"

#: Synthetic actor id used when a caller supplies no scope (single-owner path).
SYSTEM_USER_ID: Final = "system"

WorkspaceRole = Literal["owner", "admin", "member", "viewer"]

#: Highest first. Membership tests compare rank, never role strings.
ROLE_RANK: Final[dict[WorkspaceRole, int]] = {
    "owner": 40,
    "admin": 30,
    "member": 20,
    "viewer": 10,
}


@dataclass(frozen=True, slots=True)
class WorkspaceScope:
    """Who is acting, and in which workspace.

    `workspace_id` becomes a mandatory `workspace_id = ?` predicate on every
    query; `user_id` stamps authorship (`created_by_user`) on writes.
    """

    workspace_id: str = BOOTSTRAP_WORKSPACE_ID
    user_id: str = SYSTEM_USER_ID
    role: WorkspaceRole = "owner"

    def __post_init__(self) -> None:
        """Refuse an empty workspace id or an unknown role."""
        if not self.workspace_id.strip():
            msg = "workspace_id must be a non-empty string"
            raise ValueError(msg)
        if self.role not in ROLE_RANK:
            msg = f"Unknown workspace role {self.role!r}"
            raise ValueError(msg)

    def at_least(self, role: WorkspaceRole) -> bool:
        """True when this scope's role is `role` or stronger."""
        return ROLE_RANK[self.role] >= ROLE_RANK[role]


def bootstrap_scope() -> WorkspaceScope:
    """The scope an un-scoped caller resolves to."""
    return WorkspaceScope(
        workspace_id=BOOTSTRAP_WORKSPACE_ID,
        user_id=SYSTEM_USER_ID,
        role="owner",
    )


def resolve_scope(scope: WorkspaceScope | None) -> WorkspaceScope:
    """Normalise an optional scope to a concrete one (default: bootstrap)."""
    return scope if scope is not None else bootstrap_scope()
