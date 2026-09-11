// packages/server/src/retention.ts
//
// Phase 24 — the daily retention purge, re-homed from the Web UI.
//
// Before Phase 24 the purge was scheduled by Next.js `instrumentation.ts`
// (apps/web/lib/retention.ts) because the Web UI process also opened the
// database. Phase 24 removed that: the Web UI no longer opens the database at
// all, so the only long-lived, database-connected process left is the
// standalone server — which is where the schedule now lives.
//
// The work itself is core (`retention.runRetentionPurge`): at most one purge
// per 24 h, decided by the newest `retention.purge` audit row, deleting
// expired raw profile views, content snapshots, and webhook deliveries. This
// module only reads the operator environment and keeps the cadence alive:
//
//   * one run at process start (self-guarded — cold starts all re-check the
//     audit log and no-op unless a day has passed),
//   * a 24 h unref'd interval for long-lived containers, so a Docker
//     instance that never restarts still purges daily.
//
// Failures are logged and swallowed: a retention problem must never break the
// server that shares the process.

import type { PgConn, SqliteConn } from "@netpro/db";
import { retention } from "@netpro/core";
import { CONTENT_METRIC_RETENTION_DAYS } from "@netpro/core/src/content";
import { VIEW_RETENTION_DAYS } from "@netpro/core/src/views";
import { WEBHOOK_DELIVERY_RETENTION_DAYS } from "@netpro/core/src/webhooks";

export interface RetentionConfig {
  /** `NETPRO_DISABLE_RETENTION=true` → the schedule never starts. */
  enabled: boolean;
  viewRetentionDays: number;
  contentMetricRetentionDays: number;
  webhookDeliveryRetentionDays: number;
}

/** `NETPRO_DISABLE_RETENTION=true` → no purge runs at all. */
export function retentionDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.NETPRO_DISABLE_RETENTION ?? "").trim().toLowerCase() === "true";
}

/**
 * A positive integer day count from the environment; anything else (unset,
 * empty, garbage, below 1) falls back to the default. A typo in a retention
 * knob must not widen the window to "delete everything" — invalid values
 * degrade to the shipped default.
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

export function retentionConfig(
  env: Record<string, string | undefined> = process.env,
): RetentionConfig {
  return {
    enabled: !retentionDisabled(env),
    viewRetentionDays: envDayCount(env, "NETPRO_VIEW_RETENTION_DAYS", VIEW_RETENTION_DAYS),
    contentMetricRetentionDays: envDayCount(
      env,
      "NETPRO_CONTENT_METRIC_RETENTION_DAYS",
      CONTENT_METRIC_RETENTION_DAYS,
    ),
    webhookDeliveryRetentionDays: envDayCount(
      env,
      "NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS",
      WEBHOOK_DELIVERY_RETENTION_DAYS,
    ),
  };
}

export interface RetentionSchedule {
  /** Stop the interval and in-flight tracking. Called on graceful shutdown. */
  stop: () => void;
}

/**
 * Start the daily retention schedule for this process.
 *
 * Runs the purge immediately (the core guard skips it when one ran within the
 * last 24 h) and then re-checks every 24 h. The timer is unref'd so it never
 * keeps the process alive past its real work. Returns `null` when retention
 * is disabled via `NETPRO_DISABLE_RETENTION=true`.
 */
export function startRetentionSchedule(
  conn: SqliteConn | PgConn,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (line) => console.log(line),
): RetentionSchedule | null {
  const config = retentionConfig(env);
  if (!config.enabled) return null;

  const run = (): void => {
    retention
      .runRetentionPurge(conn, {
        viewRetentionDays: config.viewRetentionDays,
        contentMetricRetentionDays: config.contentMetricRetentionDays,
        webhookDeliveryRetentionDays: config.webhookDeliveryRetentionDays,
      })
      .then((result) => {
        if (!result.ran) return;
        log(
          `[netpro] retention purge: deleted ${result.profileViewsDeleted} profile view(s) ` +
            `(${result.viewRetentionDays}d window), ${result.contentMetricsDeleted} content snapshot(s) ` +
            `(${result.contentMetricRetentionDays}d window), and ${result.webhookDeliveriesDeleted} webhook delivery(s) ` +
            `(${result.webhookDeliveryRetentionDays}d window)`,
        );
      })
      .catch((error) => {
        log(`[netpro] retention purge failed: ${(error as Error).message}`);
      });
  };

  run();
  const timer = setInterval(run, retention.RETENTION_PURGE_INTERVAL_MS);
  timer.unref?.();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
