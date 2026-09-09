// packages/core/src/crm/activity.ts
//
// Best-effort `activity_log` writes. The audit trail was part of the scaffold
// schema with no producer; the CRM and campaign modules populate it so every
// mutation leaves a trace. Deliberately non-fatal: a failing audit write must
// never roll back the user's logged interaction.
import { randomUUID } from 'node:crypto';
import type { SqliteConn, PgConn } from '@netpro/db';

export interface ActivityEntry {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Audit timestamp. Defaults to the real clock; callers with an injected
   * clock (tests, batch jobs run against a `now` override) pass it through
   * so the audit row and the operation agree on "when".
   */
  createdAt?: string | null;
}

export async function writeActivityLog(
  conn: SqliteConn | PgConn,
  entry: ActivityEntry
): Promise<void> {
  const row = {
    id: randomUUID(),
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  try {
    // metadata is JSON-mode text on SQLite (object in) and plain text on
    // Postgres (stringified in) — the schema's portability trade-off.
    if (conn.dialect === 'sqlite') {
      await conn.db
        .insert(conn.schema.activityLog)
        .values({ ...row, metadata: entry.metadata ?? null });
    } else {
      await conn.db.insert(conn.schema.activityLog).values({
        ...row,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      });
    }
  } catch {
    // Audit is best-effort by design (see header).
  }
}
