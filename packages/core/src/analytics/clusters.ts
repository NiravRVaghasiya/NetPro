// packages/core/src/analytics/clusters.ts
//
// Attribute-based network clustering.
//
// This is the honest v1: group contacts by normalized company. The
// blueprint's Louvain community detection (graphology) runs on the `edges`
// table, which has no producer yet — LinkedIn's export carries no
// contact-to-contact relationships. Edge-based graph clustering lands in the
// phase that creates edges, and will reuse this module's exports.
import type { SqliteConn, PgConn } from "@netpro/db";
import { countValues, normalizedValues, projectContacts } from "./metrics";
import {
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type ClusterInfo,
  type TopValue,
} from "./types";

const TOP_ROLES = 3;

/**
 * Detect attribute clusters: non-empty companies grouped by
 * `lower(trim(company))`, largest first. Within each cluster, `label` is the
 * most common original spelling and `topRoles` the three most common roles.
 * Contacts without a company belong to no cluster.
 */
export async function detectClusters(
  conn: SqliteConn | PgConn,
  options: AnalyticsOptions = {},
): Promise<ClusterInfo[]> {
  const { limit } = resolveAnalyticsOptions(options);
  const rows = await projectContacts(conn);
  const total = rows.length;

  interface Group {
    labelCounts: Map<string, number>;
    members: Array<{ role: string | null }>;
  }

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const raw = row.company?.trim() ?? "";
    if (raw.length === 0) continue;
    const key = raw.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { labelCounts: new Map(), members: [] };
      groups.set(key, g);
    }
    g.labelCounts.set(raw, (g.labelCounts.get(raw) ?? 0) + 1);
    g.members.push({ role: row.role });
  }

  const clusters: ClusterInfo[] = [];
  for (const [key, g] of groups) {
    const label =
      Array.from(g.labelCounts.entries()).sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      )[0]?.[0] ?? key;

    const roleValues: string[] = [];
    for (const m of g.members) {
      const r = m.role?.trim() ?? "";
      if (r.length > 0) roleValues.push(r.toLowerCase());
    }
    const topRoles: TopValue[] = countValues(roleValues)
      .slice(0, TOP_ROLES)
      .map(({ value, count }) => ({
        value,
        count,
        share: g.members.length > 0 ? count / g.members.length : 0,
      }));

    clusters.push({
      key,
      label,
      size: g.members.length,
      share: total > 0 ? g.members.length / total : 0,
      topRoles,
    });
  }

  return clusters
    .sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : 1))
    .slice(0, limit);
}

/** Distinct normalized companies represented in the network (informational). */
export async function countDistinctCompanies(
  conn: SqliteConn | PgConn,
): Promise<number> {
  const rows = await projectContacts(conn);
  return new Set(normalizedValues(rows, "company")).size;
}
