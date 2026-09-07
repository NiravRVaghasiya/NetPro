// packages/core/src/analytics/overview.ts
//
// The single shared entry point for both surfaces: everything `netpro
// analyze` and `/dashboard` render comes from this one payload. Business
// logic lives here only — the CLI and web app are thin formatters.
import type { SqliteConn, PgConn } from "@netpro/db";
import { detectClusters } from "./clusters";
import { getDormantContacts } from "./dormant";
import { getGrowthSummary } from "./growth";
import {
  computeNetworkMetrics,
  computeNetworkScore,
  projectContacts,
  topValues,
} from "./metrics";
import { getNetworkGraph, type NetworkGraph } from "../graph/network";
import {
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type NetworkOverview,
} from "./types";

/** Sections rendered at "top N" granularity on both surfaces. */
export const TOP_VALUES_LIMIT = 5;

/**
 * Build the full network overview: metrics, composite score, growth,
 * top companies/industries, clusters, the dormant-ties list, and the
 * graph-analytics section (`includeGraph: false` opts out — v2.0 Phase 2).
 */
export async function getNetworkOverview(
  conn: SqliteConn | PgConn,
  options: AnalyticsOptions = {},
): Promise<NetworkOverview> {
  const { now } = resolveAnalyticsOptions(options);

  const graphPromise: Promise<NetworkGraph | undefined> =
    options.includeGraph === false
      ? Promise.resolve(undefined)
      : getNetworkGraph(conn, {
          ...options.graph,
          limit: options.graph?.limit ?? Math.min(options.limit ?? 10, 50),
          now,
        });

  const [metrics, growth, clusters, dormant, rows, graph] = await Promise.all([
    computeNetworkMetrics(conn, options),
    getGrowthSummary(conn, options),
    detectClusters(conn, options),
    getDormantContacts(conn, options),
    projectContacts(conn),
    graphPromise,
  ]);

  const score = computeNetworkScore({
    totalContacts: metrics.totalContacts,
    activeRate: metrics.activeRate,
    diversityEffective: metrics.diversityEffective,
    newLast30Days: growth.last30,
  });

  return {
    metrics,
    score,
    growth,
    topCompanies: topValues(rows, "company", metrics.totalContacts, TOP_VALUES_LIMIT),
    topIndustries: topValues(rows, "industry", metrics.totalContacts, TOP_VALUES_LIMIT),
    clusters,
    dormant,
    ...(graph ? { graph } : {}),
    generatedAt: now.toISOString(),
  };
}
