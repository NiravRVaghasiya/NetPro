// v2.5 Phase 1 — profile-view retention.
//
// Raw profile views are kept for a bounded window only (90 days by default,
// matching the plan). Older rows are deleted by the purge job — wired to a
// daily run in Phase 6 — and each purge run logs one `activity_log` row with
// the deleted count (never one row per view; views are high-volume, not
// audit). Aggregated statistics (Phase 3+) are what live longer than 90 days,
// not the raw rows.
//
// This module ships now because Phase 1's verification requires the retention
// *query* to exist and be tested ("retention query deletes > 90d"); the
// scheduling, the env knob, and the activity-log entry arrive with the
// cross-cutting phase.
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { workspaceSql, type WorkspaceScope } from "../workspaces/scope";

type Conn = SqliteConn | PgConn;

/** Default raw-view retention window, in days. */
export const VIEW_RETENTION_DAYS = 90;

export interface PurgeProfileViewsOptions {
  /** Rows older than this many days are deleted. Default 90. */
  olderThanDays?: number;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
  /**
   * v3.0 Phase 2 — when present, purge only this workspace (system sweeps
   * call once per workspace). Absent = across all workspaces.
   */
  scope?: WorkspaceScope;
}

/**
 * Deletes profile views older than the retention window and returns the
 * number of rows removed. Idempotent: a second run deletes nothing.
 */
export async function purgeExpiredProfileViews(
  conn: Conn,
  options: PurgeProfileViewsOptions = {},
): Promise<{ deleted: number }> {
  const olderThanDays = options.olderThanDays ?? VIEW_RETENTION_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new RangeError(
      `olderThanDays must be a positive number, got ${olderThanDays}`,
    );
  }
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - olderThanDays * 86_400_000,
  ).toISOString();
  const statement = options.scope
    ? sql`DELETE FROM profile_views WHERE viewed_at < ${cutoff} AND ${workspaceSql(options.scope)}`
    : sql`DELETE FROM profile_views WHERE viewed_at < ${cutoff}`;
  if (conn.dialect === "sqlite") {
    return { deleted: conn.db.run(statement).changes };
  }
  const result = await conn.db.execute(statement);
  return { deleted: result.rowCount ?? 0 };
}
