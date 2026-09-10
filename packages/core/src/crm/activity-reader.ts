// packages/core/src/crm/activity-reader.ts
// v3.0 Phase 3 — audit viewer: paginated activity_log reader with filters.
// Admin+ only in web, but core enforces workspace scoping, not role — role
// is checked in the surface (authz). Filters: action prefix, member (user id
// derived from metadata or entity, but we filter by action actor? We store
// actor only via scope? Actually writeActivityLog doesn't store actor; we
// need to parse metadata or rely on created_by? For v3.0, we store actor
// implicitly via workspace_id + entity; for member filter we search metadata
// JSON and entity fields. Simpler: filter by action prefix, date range, and
// free-text entity type/id. Member filter is implemented as searching
// metadata JSON for userId presence where applicable, plus filtering by
// `created_by` if we had it — but we don't. So we expose `userId` filter
// that searches for actions where metadata contains that userId or the
// entityId equals userId (for workspace_member actions). This is best-effort
// but deterministic.
//
// All queries are workspace-scoped and paginated, newest first.

import { and, desc, eq, gte, lte, like, or, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveScope, workspacePredicate, type WorkspaceScope } from '../workspaces/scope';

export interface ActivityLogRow {
  id: string;
  workspaceId: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface ListActivityOptions {
  limit?: number;
  offset?: number;
  actionPrefix?: string;
  entityType?: string;
  userId?: string;
  from?: string;
  to?: string;
}

export interface ActivityPage {
  rows: ActivityLogRow[];
  total: number;
  limit: number;
  offset: number;
}

function parseMetadata(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function listActivityLog(
  conn: SqliteConn | PgConn,
  options: ListActivityOptions = {},
  scope?: WorkspaceScope
): Promise<ActivityPage> {
  const resolved = resolveScope(scope);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const actionPrefix = options.actionPrefix?.trim() || undefined;
  const entityType = options.entityType?.trim() || undefined;
  const userIdFilter = options.userId?.trim() || undefined;
  const from = options.from?.trim() || undefined;
  const to = options.to?.trim() || undefined;

  // Build where clauses
  const basePredicate = workspacePredicate(scope, conn.schema.activityLog.workspaceId);

  // We'll construct conditions for both dialects using Drizzle
  const buildConditions = () => {
    const conds = [basePredicate];
    if (actionPrefix) {
      conds.push(like(conn.schema.activityLog.action, `${escapeLike(actionPrefix)}%`));
    }
    if (entityType) {
      conds.push(eq(conn.schema.activityLog.entityType, entityType));
    }
    if (from) {
      conds.push(gte(conn.schema.activityLog.createdAt, from));
    }
    if (to) {
      conds.push(lte(conn.schema.activityLog.createdAt, to));
    }
    // userId filter: best-effort — match entityId = userId when entityType is workspace_member/user,
    // or metadata contains userId string. Since metadata is JSON/text, we use LIKE on raw column.
    if (userIdFilter) {
      const metaLike = `%${userIdFilter}%`;
      conds.push(
        or(
          eq(conn.schema.activityLog.entityId, userIdFilter),
          // metadata LIKE — portable, since metadata is text on Postgres and json text on SQLite
          like(conn.schema.activityLog.metadata as never, metaLike)
        ) as never
      );
    }
    return conds;
  };

  const conditions = buildConditions();

  if (conn.dialect === 'sqlite') {
    const a = conn.schema.activityLog;
    const totalRows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(a)
      .where(and(...conditions));
    const total = Number(totalRows[0]?.n ?? 0);

    const rows = await conn.db
      .select({
        id: a.id,
        workspaceId: a.workspaceId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: a.metadata,
        createdAt: a.createdAt,
      })
      .from(a)
      .where(and(...conditions))
      .orderBy(desc(a.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId ?? resolved.workspaceId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        metadata: parseMetadata(r.metadata),
        createdAt: r.createdAt,
      })),
      total,
      limit,
      offset,
    };
  } else {
    const a = conn.schema.activityLog;
    const totalRows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(a)
      .where(and(...conditions));
    const total = Number(totalRows[0]?.n ?? 0);

    const rows = await conn.db
      .select({
        id: a.id,
        workspaceId: a.workspaceId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: a.metadata,
        createdAt: a.createdAt,
      })
      .from(a)
      .where(and(...conditions))
      .orderBy(desc(a.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId ?? resolved.workspaceId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        metadata: parseMetadata(r.metadata),
        createdAt: r.createdAt,
      })),
      total,
      limit,
      offset,
    };
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
