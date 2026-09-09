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
  getContentOverview,
  type ContentOverview,
} from "../content/repository";
import { getViewsOverview, type ViewsOverview } from "../views/analytics";
import {
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type NetworkOverview,
} from "./types";

/** Sections rendered at "top N" granularity on both surfaces. */
export const TOP_VALUES_LIMIT = 5;

/**
 * Build the full network overview: metrics, composite score, growth,
 * top companies/industries, clusters, the dormant-ties list, the
 * graph-analytics section (`includeGraph: false` opts out — v2.0 Phase 2),
 * the viewer-analytics section (`includeViews: false` opts out —
 * v2.5 Phase 3), and the content-tracker overview
 * (`includeContent: false` opts out — v2.5 Phase 6).
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
          scope: options.scope,
        });

  // The dashboard strip wants a compact payload: 5 breakdown rows, 5 recent
  // views, 5 known visitors. Callers needing more pass `views:` explicitly
  // (the settings page) or call `getViewsOverview` directly (the API).
  const viewsPromise: Promise<ViewsOverview | undefined> =
    options.includeViews === false
      ? Promise.resolve(undefined)
      : getViewsOverview(
          conn,
          {
            days: options.views?.days ?? 30,
            limit: options.views?.limit ?? 5,
            includeBots: options.views?.includeBots,
            includeOwnerViews: options.views?.includeOwnerViews,
            now,
          },
          options.scope,
        );

  // v2.5 Phase 6 — the content strip reads the same all-time overview the
  // `/content` page and dashboard shared before; all-time (no window) so the
  // dashboard numbers are unchanged by the fold-in.
  const contentPromise: Promise<ContentOverview | undefined> =
    options.includeContent === false
      ? Promise.resolve(undefined)
      : getContentOverview(conn, { now, scope: options.scope });

  const [metrics, growth, clusters, dormant, rows, graph, views, content] =
    await Promise.all([
      computeNetworkMetrics(conn, options),
      getGrowthSummary(conn, options),
      detectClusters(conn, options),
      getDormantContacts(conn, options),
      projectContacts(conn, options.scope),
      graphPromise,
      viewsPromise,
      contentPromise,
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
    topCompanies: topValues(
      rows,
      "company",
      metrics.totalContacts,
      TOP_VALUES_LIMIT,
    ),
    topIndustries: topValues(
      rows,
      "industry",
      metrics.totalContacts,
      TOP_VALUES_LIMIT,
    ),
    clusters,
    dormant,
    ...(graph ? { graph } : {}),
    ...(views ? { views } : {}),
    ...(content ? { content } : {}),
    generatedAt: now.toISOString(),
  };
}
