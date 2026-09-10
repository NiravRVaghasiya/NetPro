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

/** Dominant normalized company in a member set, else `Community N` (shared with position.ts). */
export function communityLabel(graph: LoadedGraph, members: readonly string[], communityId: number): string {
  const labelCounts = new Map<string, number>();
  for (const id of members) {
    const company = graph.nodes.get(id)?.company?.trim();
    if (company) {
      const key = company.toLowerCase();
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }
  }
  return (
    Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ??
    `Community ${communityId + 1}`
  );
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
      const label = communityLabel(graph, members, communityId);
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

export interface ResolvedCommunity {
  /**
   * Display label: the single matched community's label, or a
   * `"N communities matching …"` line when a substring matched several.
   */
  label: string;
  /** 0-based community ids that matched, sorted. */
  communityIds: number[];
  /** Union of member contact ids across every matched community, sorted. */
  memberIds: string[];
}

/**
 * Resolve a community selector to member ids (Phase 12 — search filtering).
 *
 * Accepts, in order:
 *   1. a 0-based community id (`0`, `1`, …) — digits mean an id, nothing else;
 *   2. `Community N` (1-based, the human label the UI shows);
 *   3. an exact label match (case-insensitive, e.g. `acme`);
 *   4. a label substring (case-insensitive) — every matching community
 *      contributes its members, so `e` over `acme` + `globex` returns both.
 *
 * Returns null when nothing matches (unknown id/label, or an edge-less graph
 * with no communities at all). Callers treat null as "match nothing" — the
 * same posture as an unknown skill filter: a typo narrows to zero, never
 * silently widens. Runs over the analyzed graph (default: confirmed edges).
 */
export async function resolveCommunityMembers(
  conn: SqliteConn | PgConn,
  selector: string,
  opts: GraphAnalysisOptions = {}
): Promise<ResolvedCommunity | null> {
  const needle = selector.trim().toLowerCase();
  if (!needle) return null;

  const graph = await loadGraph(conn, opts);
  const found = louvain(graph);
  if (found.communities.length === 0) return null;

  const labeled = found.communities.map((members, communityId) => ({
    communityId,
    label: communityLabel(graph, members, communityId),
    members,
  }));

  const pack = (
    matches: typeof labeled,
    label: string,
  ): ResolvedCommunity => ({
    label,
    communityIds: matches.map((c) => c.communityId).sort((a, b) => a - b),
    memberIds: Array.from(new Set(matches.flatMap((c) => c.members))).sort(),
  });

  // 1. Pure digits address a community id directly.
  if (/^\d+$/.test(needle)) {
    const id = Number(needle);
    const exact = labeled.find((c) => c.communityId === id);
    return exact ? pack([exact], exact.label) : null;
  }

  // 2. `Community N` is the 1-based human label.
  const human = needle.match(/^community\s+(\d+)$/);
  if (human) {
    const id = Number(human[1]) - 1;
    const exact = labeled.find((c) => c.communityId === id);
    return exact ? pack([exact], exact.label) : null;
  }

  // 3. Exact label beats substring (deterministic when one label extends
  // another, e.g. `acme` vs `acme labs`).
  const exactLabel = labeled.filter((c) => c.label.toLowerCase() === needle);
  if (exactLabel.length > 0) {
    return pack(
      exactLabel,
      exactLabel.length === 1
        ? exactLabel[0]!.label
        : `${exactLabel.length} communities matching "${selector.trim()}"`,
    );
  }

  // 4. Substring union.
  const partial = labeled.filter((c) =>
    c.label.toLowerCase().includes(needle),
  );
  if (partial.length === 0) return null;
  return pack(
    partial,
    partial.length === 1
      ? partial[0]!.label
      : `${partial.length} communities matching "${selector.trim()}"`,
  );
}
