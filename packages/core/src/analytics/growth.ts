// packages/core/src/analytics/growth.ts
//
// Network growth over time.
//
// Buckets are computed in JS (UTC month keys), not in SQL — `strftime` and
// `date_trunc` are dialect-specific, while ISO-8601 UTC strings sort and
// compare identically everywhere. The projection query stays portable.
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  projectContacts,
} from "./metrics";
import {
  monthKey,
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type GrowthPoint,
  type GrowthSummary,
} from "./types";

/**
 * Growth summary: a month-by-month series (window includes the current
 * partial month) plus 30-day new-contact counts and the period-over-period
 * rate. `cumulative` starts from every contact older than the window, so the
 * series totals the whole network at each step.
 */
export async function getGrowthSummary(
  conn: SqliteConn | PgConn,
  options: AnalyticsOptions = {},
): Promise<GrowthSummary> {
  const { growthMonths, now } = resolveAnalyticsOptions(options);
  const rows = await projectContacts(conn);

  // Month buckets oldest → newest, current partial month last.
  const buckets: string[] = [];
  for (let i = growthMonths - 1; i >= 0; i -= 1) {
    buckets.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  const bucketIndex = new Map(buckets.map((m, i) => [m, i]));

  const counts = new Array<number>(buckets.length).fill(0);
  let before = 0;
  let last30 = 0;
  let prior30 = 0;

  const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  for (const row of rows) {
    const created = row.createdAt;
    // Bucket by UTC month key; anything older than the window feeds the
    // `before` baseline so `cumulative` totals the whole network.
    const mk = monthKey(new Date(`${created.slice(0, 10)}T00:00:00.000Z`));
    const idx = bucketIndex.get(mk);
    if (idx === undefined) {
      if (mk < buckets[0]) before += 1;
      // A month key newer than `now`'s month (clock skew / bad data) has no
      // bucket and no baseline — ignore it rather than corrupting either.
    } else {
      counts[idx] += 1;
    }
    if (created >= cutoff30) {
      last30 += 1;
    } else if (created >= cutoff60) {
      prior30 += 1;
    }
  }

  const series: GrowthPoint[] = [];
  let cumulative = before;
  for (let i = 0; i < buckets.length; i += 1) {
    cumulative += counts[i];
    series.push({ month: buckets[i], count: counts[i], cumulative });
  }

  return {
    series,
    last30,
    prior30,
    ratePct: prior30 > 0 ? Math.round(((last30 - prior30) / prior30) * 1000) / 10 : null,
  };
}
