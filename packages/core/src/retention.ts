// v2.5 Phase 6 — the daily retention purge.
//
// Cross-cuts the two bounded tables the plan names:
//
//   * `profile_views` — raw views older than 90 days (Phase 1's window) go;
//     aggregated analytics (Phase 3) are what live longer.
//   * `content_metrics` — snapshots older than 365 days go, but the latest
//     snapshot per content item always survives.
//
// Cadence: **at most one run per 24 hours, decided by the data, not the
// process.** The guard reads the newest `activity_log` row with
// `action = 'retention.purge'` and skips when it is younger than the
// interval. That makes the job safe to start on every boot of every
// instance — a long-lived Docker container runs it once and then its 24 h
// timer keeps the cadence, and a serverless deploy's cold starts each
// re-check the same log and no-op unless a day has passed. No queue, no
// cron table, no new migration: the audit log *is* the state.
//
// Concurrency is tolerated, not eliminated: two instances that both see
// "due" in the same second both delete (idempotent — the second removes
// nothing) and both log. A duplicate run costs one extra row with zeros;
// correctness never depends on the race.
//
// Every run writes exactly one `activity_log` row (`action =
// 'retention.purge'`) carrying the deleted counts in its metadata —
// never one row per deleted row; views and snapshots are high-volume, not
// audit.
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { writeActivityLog } from "./crm/activity";
import { rawAll } from "./search/indexer";
import { CONTENT_METRIC_RETENTION_DAYS, purgeExpiredContentMetrics } from "./content/retention";
import { VIEW_RETENTION_DAYS, purgeExpiredProfileViews } from "./views/retention";

type Conn = SqliteConn | PgConn;

/** The `activity_log` action the purge stamps — also its "last run" marker. */
export const RETENTION_PURGE_ACTION = "retention.purge";

/** Default minimum time between purge runs. */
export const RETENTION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RunRetentionPurgeOptions {
  /** Clock override for tests. Defaults to now. */
  now?: Date;
  /** Profile-view retention window in days. Default 90. */
  viewRetentionDays?: number;
  /** Content-snapshot retention window in days. Default 365. */
  contentMetricRetentionDays?: number;
  /** Minimum time between runs. Default 24 h; `0` disables the guard. */
  minIntervalMs?: number;
  /** Ignore the "last run" guard (manual re-runs, tests). */
  force?: boolean;
}

export interface RetentionPurgeResult {
  /** False when the interval guard skipped the run. */
  ran: boolean;
  /** Why the run was skipped, when it was. */
  skipped: "recent" | null;
  /** The newest earlier `retention.purge` row, if any. */
  lastRunAt: string | null;
  profileViewsDeleted: number;
  contentMetricsDeleted: number;
  viewRetentionDays: number;
  contentMetricRetentionDays: number;
}

async function lastPurgeAt(conn: Conn): Promise<string | null> {
  const rows = await rawAll<{ created_at: string }>(
    conn,
    sql`SELECT created_at FROM activity_log
        WHERE action = ${RETENTION_PURGE_ACTION}
        ORDER BY created_at DESC
        LIMIT 1`,
  );
  return rows[0]?.created_at ?? null;
}

/**
 * Run the daily retention purge if it is due.
 *
 * Reads the last `retention.purge` audit row, skips when it is younger than
 * `minIntervalMs` (unless `force`), otherwise deletes expired profile views
 * and content snapshots and writes one audit row with the counts. The
 * audit write is best-effort (a failed log must not take the purge down);
 * if it fails, the next tick simply re-runs the — idempotent — deletes.
 */
export async function runRetentionPurge(
  conn: Conn,
  options: RunRetentionPurgeOptions = {},
): Promise<RetentionPurgeResult> {
  const now = options.now ?? new Date();
  const viewRetentionDays = options.viewRetentionDays ?? VIEW_RETENTION_DAYS;
  const contentMetricRetentionDays =
    options.contentMetricRetentionDays ?? CONTENT_METRIC_RETENTION_DAYS;
  const minIntervalMs = options.minIntervalMs ?? RETENTION_PURGE_INTERVAL_MS;
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new RangeError(
      `minIntervalMs must be a non-negative number, got ${minIntervalMs}`,
    );
  }

  const base: RetentionPurgeResult = {
    ran: false,
    skipped: null,
    lastRunAt: null,
    profileViewsDeleted: 0,
    contentMetricsDeleted: 0,
    viewRetentionDays,
    contentMetricRetentionDays,
  };

  const lastRunAt = await lastPurgeAt(conn);
  base.lastRunAt = lastRunAt;
  if (!options.force && minIntervalMs > 0 && lastRunAt !== null) {
    const last = Date.parse(lastRunAt);
    if (!Number.isNaN(last) && now.getTime() - last < minIntervalMs) {
      return { ...base, skipped: "recent" };
    }
  }

  const [views, metrics] = await Promise.all([
    purgeExpiredProfileViews(conn, { now, olderThanDays: viewRetentionDays }),
    purgeExpiredContentMetrics(conn, { now, olderThanDays: contentMetricRetentionDays }),
  ]);

  await writeActivityLog(conn, {
    action: RETENTION_PURGE_ACTION,
    entityType: "retention",
    metadata: {
      profileViewsDeleted: views.deleted,
      contentMetricsDeleted: metrics.deleted,
      viewRetentionDays,
      contentMetricRetentionDays,
    },
    createdAt: now.toISOString(),
  });

  return {
    ...base,
    ran: true,
    profileViewsDeleted: views.deleted,
    contentMetricsDeleted: metrics.deleted,
  };
}
