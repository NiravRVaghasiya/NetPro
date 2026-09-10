// packages/core/src/graph/visualization.ts
//
// Phase 11 — Network visualization data.
// Provides the interactive graph payload consumed by the Web UI via
// `GET /api/graph/visualization` (see @netpro/server). It never reimplements
// graph algorithms — it annotates the `loadGraph()` adjacency with the
// outputs of Louvain and centrality so the UI can color by community, size by
// degree, and highlight bridges without recomputing.
//
// The payload is bounded for browser performance: when the graph exceeds
// `visualizationLimit` nodes we keep the top-degree subset plus all edges
// between them, and the response is marked `truncated`. The same option
// filters (`status`, `relation`, `minConfidence`) are forwarded from the
// query string so the UI's filters stay server-driven.

import type { SqliteConn, PgConn } from '@netpro/db';
import { loadGraph, resolveGraphAnalysisOptions, type GraphAnalysisOptions } from './analysis';
import { centralityOf } from './centrality';
import { communitiesOf } from './communities';
import { louvain } from './louvain';
import { countEdges } from './edges';

export interface VisualizationNode {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  lastInteraction: string | null;
  communityId: number;
  communityLabel: string;
  degree: number;
  betweenness: number | null;
  /** Share of community size, 0–1, for subtle intensity. */
  communityShare: number;
}

export interface VisualizationEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: number;
  confidence: number;
  bidirectional: boolean;
}

export interface GraphVisualization {
  generatedAt: string;
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  meta: {
    totalContacts: number;
    totalNodes: number;
    totalEdges: number;
    shownNodes: number;
    shownEdges: number;
    truncated: boolean;
    truncatedReason: string | null;
    communities: number;
    modularity: number;
    components: { count: number; largestSize: number };
    coverage: number;
    pendingCandidates: number;
    visualizationLimit: number;
    degraded: { reason: string; edges: number; maxEdges: number } | null;
  };
}

const DEFAULT_VISUALIZATION_LIMIT = 400;

export type VisualizationOptions = GraphAnalysisOptions & {
  visualizationLimit?: number;
};

function resolveVisualizationLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_VISUALIZATION_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 10), 1000);
}

/**
 * Build the visualization payload for the interactive Network graph.
 * Falls back to the same degraded path as getNetworkGraph: when edges exceed
 * the analysis cap we return just the counts with degraded reason so the UI
 * can show the same honest banner as the textual overview.
 */
export async function getNetworkVisualization(
  conn: SqliteConn | PgConn,
  opts: VisualizationOptions = {}
): Promise<GraphVisualization> {
  const resolved = resolveGraphAnalysisOptions(opts);
  const vizLimit = resolveVisualizationLimit(opts.visualizationLimit ?? DEFAULT_VISUALIZATION_LIMIT);
  const graph = await loadGraph(conn, opts);
  const pendingCandidates = await countEdges(conn, { status: 'pending' }, opts.scope);

  const totalContacts = graph.stats.totalContacts;
  const coverage = totalContacts > 0 ? Math.round((graph.stats.nodes / totalContacts) * 1000) / 1000 : 0;

  // Degraded: same 50k cap as NetworkGraph
  if (graph.stats.edges > resolved.limits.maxEdges) {
    return {
      generatedAt: resolved.now.toISOString(),
      nodes: [],
      edges: [],
      meta: {
        totalContacts,
        totalNodes: graph.stats.nodes,
        totalEdges: graph.stats.edges,
        shownNodes: 0,
        shownEdges: 0,
        truncated: true,
        truncatedReason: `graph has ${graph.stats.edges} edges — visualization capped at ${resolved.limits.maxEdges}`,
        communities: 0,
        modularity: 0,
        components: { count: 0, largestSize: 0 },
        coverage,
        pendingCandidates,
        visualizationLimit: vizLimit,
        degraded: {
          reason: `graph has ${graph.stats.edges} edges — analysis is capped at ${resolved.limits.maxEdges}`,
          edges: graph.stats.edges,
          maxEdges: resolved.limits.maxEdges,
        },
      },
    };
  }

  if (graph.nodes.size === 0) {
    return {
      generatedAt: resolved.now.toISOString(),
      nodes: [],
      edges: [],
      meta: {
        totalContacts,
        totalNodes: 0,
        totalEdges: 0,
        shownNodes: 0,
        shownEdges: 0,
        truncated: false,
        truncatedReason: null,
        communities: 0,
        modularity: 0,
        components: { count: 0, largestSize: 0 },
        coverage,
        pendingCandidates,
        visualizationLimit: vizLimit,
        degraded: null,
      },
    };
  }

  // Communities → map node → communityId + label
  const louvainResult = louvain(graph);
  const commInfo = communitiesOf(graph, louvainResult, 25);
  const nodeToCommunity = new Map<string, number>();
  const communityIdToMeta = new Map<number, { label: string; share: number }>();
  for (const c of commInfo.top) {
    // commInfo.top is sorted by size, but communityId is original
    // For visualization we map by Louvain community id, so rebuild from raw partition
    // Safer: iterate louvainResult.communities to map
  }
  // Build node→community from Louvain raw partition
  for (let cid = 0; cid < louvainResult.communities.length; cid++) {
    const members = louvainResult.communities[cid]!;
    for (const nid of members) nodeToCommunity.set(nid, cid);
  }
  for (const c of commInfo.top) {
    communityIdToMeta.set(c.communityId, { label: c.label, share: c.share });
  }
  // Also for communities not in top (when truncated), still have label fallback
  for (let cid = 0; cid < louvainResult.communities.length; cid++) {
    if (!communityIdToMeta.has(cid)) communityIdToMeta.set(cid, { label: `Community ${cid + 1}`, share: 0 });
  }

  // Centrality → per-node degree/betweenness
  const cent = centralityOf(graph, { ...opts, limit: graph.nodes.size });
  const centMap = new Map<string, { degree: number; betweenness: number | null }>();
  // centralityOf returns only top `limit` but we set limit to node count so all are there.
  // Build degree map still via neighbors for nodes not in top? but top now has all.
  for (const t of cent.top) centMap.set(t.contactId, { degree: t.degree, betweenness: t.betweenness });
  // Ensure every node has entry (in case centrality top truncated? we used full)
  for (const nid of graph.nodes.keys()) {
    if (!centMap.has(nid)) centMap.set(nid, { degree: graph.neighbors.get(nid)?.length ?? 0, betweenness: null });
  }

  // Determine truncation
  let keepIds: Set<string> | null = null;
  let truncated = false;
  let truncatedReason: string | null = null;

  if (graph.nodes.size > vizLimit) {
    truncated = true;
    // Keep highest-degree nodes
    const sorted = Array.from(graph.nodes.keys())
      .map((id) => ({ id, degree: graph.neighbors.get(id)?.length ?? 0 }))
      .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
      .slice(0, vizLimit)
      .map((r) => r.id);
    keepIds = new Set(sorted);
    truncatedReason = `showing ${vizLimit} of ${graph.nodes.size} nodes (highest degree); filter or increase limit to see more`;
  }

  const nodes: VisualizationNode[] = [];
  for (const [id, gNode] of graph.nodes) {
    if (keepIds && !keepIds.has(id)) continue;
    const cid = nodeToCommunity.get(id) ?? 0;
    const meta = communityIdToMeta.get(cid) ?? { label: `Community ${cid + 1}`, share: 0 };
    const c = centMap.get(id) ?? { degree: graph.neighbors.get(id)?.length ?? 0, betweenness: null };
    nodes.push({
      id,
      fullName: gNode.fullName,
      company: gNode.company,
      role: gNode.role,
      relationshipScore: gNode.relationshipScore ?? null,
      lastInteraction: gNode.lastInteraction ?? null,
      communityId: cid,
      communityLabel: meta.label,
      degree: c.degree,
      betweenness: c.betweenness,
      communityShare: meta.share,
    });
  }
  // Deterministic order: by degree desc then id
  nodes.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));

  const shownNodeSet = new Set(nodes.map((n) => n.id));
  const edges: VisualizationEdge[] = [];
  for (const e of graph.edges) {
    if (keepIds && (!shownNodeSet.has(e.sourceId) || !shownNodeSet.has(e.targetId))) continue;
    edges.push({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      relation: e.relation,
      strength: e.strength ?? 0.5,
      confidence: e.confidence ?? 1,
      bidirectional: e.bidirectional ?? true,
    });
  }
  // Deterministic
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Components for meta — reuse same union-find as NetworkGraph would
  const parent = new Map<string, string>();
  const sz = new Map<string, number>();
  for (const n of nodes) { parent.set(n.id, n.id); sz.set(n.id, 1); }
  const find = (x: string): string => {
    let r = x; while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = x; while (parent.get(cur) !== r) { const nxt = parent.get(cur)!; parent.set(cur, r); cur = nxt; }
    return r;
  };
  for (const e of edges) {
    if (e.source === e.target) continue;
    const a = e.source, b = e.target;
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    sz.set(keep, (sz.get(keep) ?? 1) + (sz.get(drop) ?? 1));
    sz.delete(drop);
  }
  const sizes = Array.from(sz.values()).sort((a, b) => b - a);
  const largestSize = sizes[0] ?? 0;

  return {
    generatedAt: resolved.now.toISOString(),
    nodes,
    edges,
    meta: {
      totalContacts,
      totalNodes: graph.stats.nodes,
      totalEdges: graph.stats.edges,
      shownNodes: nodes.length,
      shownEdges: edges.length,
      truncated,
      truncatedReason,
      communities: commInfo.count,
      modularity: commInfo.modularity,
      components: { count: sizes.length, largestSize },
      coverage,
      pendingCandidates,
      visualizationLimit: vizLimit,
      degraded: null,
    },
  };
}
