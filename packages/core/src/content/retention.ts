// v2.5 Phase 6 — content-metric retention.
//
// `content_metrics` snapshots grow without bound (one row per recorded
// sample, append-only by design). This module bounds them: rows older than
// the retention window (365 days by default, matching the plan) are deleted
// by the purge job — but the latest snapshot per piece of content always
// survives, even when it is older than the window. A library whose last
// snapshot was taken two years ago must still show that number, not a blank.
//
// The scheduling (daily run, activity_log entry, env knobs) lives in
// `packages/core/src/retention.ts`, which composes this query with the
// profile-view purge from `../views/retention.ts`.
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";

type Conn = SqliteConn | PgConn;

/** Default content-snapshot retention window, in days. */
export const CONTENT_METRIC_RETENTION_DAYS = 365;

export interface PurgeContentMetricsOptions {
  /** Snapshots older than this many days are deleted (latest per item kept). Default 365. */
  olderThanDays?: number;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
}

/**
 * Deletes content-metric snapshots older than the retention window and
 * returns the number of rows removed. The newest snapshot of each content
 * item is never deleted: "newest" is strictly newer per
 * `(content_id, fetched_at)`, so ties for the newest timestamp all survive
 * (keeping ambiguous duplicates is the safe side of the boundary).
 * Idempotent: a second run deletes nothing.
 */
export async function purgeExpiredContentMetrics(
  conn: Conn,
  options: PurgeContentMetricsOptions = {},
): Promise<{ deleted: number }> {
  const olderThanDays = options.olderThanDays ?? CONTENT_METRIC_RETENTION_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new RangeError(
      `olderThanDays must be a positive number, got ${olderThanDays}`,
    );
  }
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - olderThanDays * 86_400_000,
  ).toISOString();
  // Portable on both dialects: the correlated subquery is answered by the
  // (content_id, fetched_at) index Phase 4 shipped, and the delete touches
  // only rows past the cutoff.
  const statement = sql`DELETE FROM content_metrics
      WHERE fetched_at < ${cutoff}
        AND fetched_at < (
          SELECT MAX(m2.fetched_at) FROM content_metrics m2
          WHERE m2.content_id = content_metrics.content_id
        )`;
  if (conn.dialect === "sqlite") {
    return { deleted: conn.db.run(statement).changes };
  }
  const result = await conn.db.execute(statement);
  return { deleted: result.rowCount ?? 0 };
}
