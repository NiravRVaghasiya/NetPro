// packages/core/src/graph/communities.ts
//
// `getCommunities()` — Louvain community detection over the analyzed edge
// graph (v2.0 plan §Phase 2). Clustering becomes graph-native here: the
// attribute-based `analytics/clusters.ts` stays as the fallback surface for
// graphs without confirmed edges (and for the "you have N people at Stripe"
// framing, which is a different question than who-knows-whom).
import type { SqliteConn, PgConn } from '@netpro/db';
import { loadGraph, type GraphAnalysisOptions, type LoadedGraph, resolveGraphAnalysisOptions, GRAPH_ANALYSIS_LIMITS } from './analysis';
import { louvain, type LouvainResult } from './louvain';

export interface CommunityInfo {
  /** 0-based community id, ordered by first member id (determinism). */
  communityId: number;
  /** Most common company in the group (lowercased-normalized), else `Community N`. */
  label: string;
  size: number;
  /** size / analyzed-node count. */
  share: number;
  /** Preview members sorted by id; capped by the analysis limits. */
  members: Array<{ contactId: string; fullName: string }>;
  /** True when `members` was truncated. */
  truncated: boolean;
}

export interface CommunitiesInfo {
  modularity: number;
  count: number;
  top: CommunityInfo[];
  /** Graph-wide totals this was computed on. */
  nodes: number;
  edges: number;
}

/** Pure half — exported for tests and getNetworkGraph (one load). */
export function communitiesOf(
  graph: LoadedGraph,
  louvainResult: LouvainResult,
  memberCap: number = GRAPH_ANALYSIS_LIMITS.communityMembers
): CommunitiesInfo {
  const count = louvainResult.communities.length;
  const n = graph.nodes.size;
  const top: CommunityInfo[] = louvainResult.communities
    .map((members, communityId) => {
      const labelCounts = new Map<string, number>();
      for (const id of members) {
        const company = graph.nodes.get(id)?.company?.trim();
        if (company) {
          const key = company.toLowerCase();
          labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
        }
      }
      const label =
        Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ??
        `Community ${communityId + 1}`;
      const preview = members.slice(0, memberCap).map((contactId) => ({
        contactId,
        fullName: graph.nodes.get(contactId)?.fullName ?? contactId,
      }));
      return {
        communityId,
        label,
        size: members.length,
        share: n > 0 ? members.length / n : 0,
        members: preview,
        truncated: members.length > preview.length,
      };
    })
    .sort((a, b) => b.size - a.size || a.communityId - b.communityId);

  return {
    modularity: Math.round(louvainResult.modularity * 1e4) / 1e4,
    count,
    top,
    nodes: n,
    edges: graph.edges.length,
  };
}

/**
 * Run Louvain + labeling for a stored graph. `opts.limit` sizes the `top`
 * list; members preview is capped separately.
 */
export async function getCommunities(
  conn: SqliteConn | PgConn,
  opts: GraphAnalysisOptions = {}
): Promise<CommunitiesInfo> {
  const graph = await loadGraph(conn, opts);
  const resolved = resolveGraphAnalysisOptions(opts);
  const result = communitiesOf(graph, louvain(graph), resolved.limits.communityMembers);
  return { ...result, top: result.top.slice(0, resolved.limit) };
}
