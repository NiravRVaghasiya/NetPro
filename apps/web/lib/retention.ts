// apps/web/lib/retention.ts — v2.5 Phase 6: the daily retention purge,
// scheduled in the web process (in-memory, no queue infra).
//
// The work itself is core (`runRetentionPurge`): at most one purge per 24 h,
// decided by the newest `retention.purge` audit row, deleting expired raw
// profile views and content snapshots. This module only reads the operator
// environment and keeps the cadence alive:
//
//   * one run at process start (self-guarded — cold starts of a serverless
//     deploy all re-check the audit log and no-op unless a day has passed),
//   * a 24 h unref'd interval for long-lived containers, so a Docker
//     instance that never restarts still purges daily.
//
// Failures are logged and swallowed: a retention problem must never break
// the page that shares the process.
import type { PgConn, SqliteConn } from "@netpro/db";
import { CONTENT_METRIC_RETENTION_DAYS } from "@netpro/core/src/content";
import { runRetentionPurge, RETENTION_PURGE_INTERVAL_MS } from "@netpro/core/src/retention";
import { VIEW_RETENTION_DAYS } from "@netpro/core/src/views";

export interface RetentionConfig {
  /** `NETPRO_DISABLE_RETENTION=true` → the schedule never starts. */
  enabled: boolean;
  viewRetentionDays: number;
  contentMetricRetentionDays: number;
}

/** `NETPRO_DISABLE_RETENTION=true` → no purge runs at all. */
export function retentionDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.NETPRO_DISABLE_RETENTION ?? "").trim().toLowerCase() === "true";
}

/**
 * A positive integer day count from the environment; anything else (unset,
 * empty, garbage, below 1) falls back to the default. A typo in a retention
 * knob must not 500 a page or, worse, widen the window to "delete
 * everything" — so invalid values degrade to the shipped default.
 */
function envDayCount(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function retentionConfig(env: Record<string, string | undefined> = process.env): RetentionConfig {
  return {
    enabled: !retentionDisabled(env),
    viewRetentionDays: envDayCount(env, "NETPRO_VIEW_RETENTION_DAYS", VIEW_RETENTION_DAYS),
    contentMetricRetentionDays: envDayCount(
      env,
      "NETPRO_CONTENT_METRIC_RETENTION_DAYS",
      CONTENT_METRIC_RETENTION_DAYS,
    ),
  };
}

/**
 * Start the daily retention schedule for this process.
 *
 * Runs the purge immediately (the core guard skips it when one ran within
 * the last 24 h) and then re-checks every 24 h. The timer is unref'd so it
 * never keeps a serverless instance alive past its request. Returns
 * whether the schedule started (false when retention is disabled).
 */
export function scheduleRetentionPurge(
  conn: SqliteConn | PgConn,
  env: Record<string, string | undefined> = process.env,
): { started: boolean } {
  const config = retentionConfig(env);
  if (!config.enabled) return { started: false };

  const run = (): void => {
    runRetentionPurge(conn, {
      viewRetentionDays: config.viewRetentionDays,
      contentMetricRetentionDays: config.contentMetricRetentionDays,
    })
      .then((result) => {
        if (!result.ran) return;
        console.info(
          `[netpro] retention purge: deleted ${result.profileViewsDeleted} profile view(s) ` +
            `(${result.viewRetentionDays}d window) and ${result.contentMetricsDeleted} content snapshot(s) ` +
            `(${result.contentMetricRetentionDays}d window)`,
        );
      })
      .catch((error) => {
        // Best-effort by design: the audit log and the deletes both live in
        // the same database, and a purge failure is an operator problem,
        // not a request-path problem.
        console.error("[netpro] retention purge failed:", (error as Error).message);
      });
  };

  run();
  const timer = setInterval(run, RETENTION_PURGE_INTERVAL_MS);
  timer.unref?.();
  return { started: true };
}
