// packages/core/src/workspaces/scope.ts
// v3.0 Phase 2 — workspace scope helpers.
//
// Every exported function in `packages/core` that touches data takes an
// optional `WorkspaceScope` (see ./types.ts). When omitted it resolves to the
// bootstrap workspace so that single-owner installs — and every existing
// CLI/test/web caller that predates tenancy — behave exactly as before. When
// present, the scope's `workspaceId` becomes a mandatory predicate on every
// query, and the scope's `userId` stamps authorship on writes.
//
// Scoping is enforced here, in the core, never trusted to a caller: a surface
// (CLI / web) may only influence its scope by supplying the principal that an
// authenticating layer already resolved. There is no path for an external
// request to inject a `workspaceId` that then widens a query.

import { eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { WorkspaceScope } from "./types";

export type { WorkspaceScope } from "./types";

/** The workspace a fresh install is migrated into; every bootstrap row lives here. */
export const BOOTSTRAP_WORKSPACE_ID = "default";
/** Synthetic actor id used when a caller supplies no scope (single-owner path). */
export const SYSTEM_USER_ID = "system";

/**
 * The scope an un-scoped caller resolves to. Keeps the v2.5 compatibility
 * guarantee: a single-workspace, single-member install behaves identically.
 */
export function bootstrapScope(): WorkspaceScope {
  return {
    workspaceId: BOOTSTRAP_WORKSPACE_ID,
    role: "owner",
    userId: SYSTEM_USER_ID,
  };
}

/** Normalize an optional scope to a concrete one (default = bootstrap). */
export function resolveScope(
  scope: WorkspaceScope | undefined,
): WorkspaceScope {
  return scope ?? bootstrapScope();
}

/**
 * The `workspace_id = ?` predicate for a query. Uses the resolved workspace id
 * so that an un-scoped call is always constrained to the bootstrap workspace.
 */
export function workspacePredicate(
  scope: WorkspaceScope | undefined,
  workspaceColumn: AnyColumn,
): SQL {
  return eq(workspaceColumn, resolveScope(scope).workspaceId);
}

/**
 * Raw-SQL `workspace_id = ?` predicate for the modules that query with
 * `sql` templates instead of the typed query builder (search arms, the
 * indexer, the analytics/content/overview SQL). The column reference is a
 * compile-time literal (never request input); only the workspace id is a
 * bind parameter.
 */
export function workspaceSql(
  scope: WorkspaceScope | undefined,
  column = "workspace_id",
): SQL {
  return sql`${sql.raw(column)} = ${resolveScope(scope).workspaceId}`;
}
