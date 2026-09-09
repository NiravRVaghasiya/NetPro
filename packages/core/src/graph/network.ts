// packages/core/src/graph/network.ts
//
// getNetworkGraph() — the merged graph-analytics view for the dashboard and
// `netpro analyze --graph` (v2.0 plan §Phase 2): node/edge stats, Louvain
// communities, centrality, components, average path length, and the
// warm-intro candidate list.
//
// Honesty rules:
//   * One loadGraph pass feeds every section (single indexed read + pure JS).
//   * Above `limits.maxEdges` (default 50k) the whole analysis is skipped
//     with a documented reason — the plan's degradation path ("fall back to
//     attribute clusters with a notice"). Small graphs get exact everything.
//   * Betweenness and average path length have their own node budgets; a
//     skip is reported as `null` + reason, never as a zero.
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  loadGraph,
  resolveGraphAnalysisOptions,
  type GraphAnalysisOptions,
  type LoadedGraph,
} from "./analysis";
import { centralityOf, type CentralityInfo } from "./centrality";
import { communitiesOf, type CommunitiesInfo } from "./communities";
import { louvain } from "./louvain";
import { countEdges } from "./edges";

export interface GraphComponents {
  count: number;
  largestSize: number;
  /** Analyzed nodes not attached to the largest component. */
  outsideLargest: number;
}

export interface AvgPathLength {
  /** Mean shortest-path hops over all reachable unordered pairs; null when skipped/undefined. */
  value: number | null;
  basis: "exact" | "skipped";
  note: string | null;
}

export interface WarmIntroCandidate {
  /** The contact you'd like to reach (low touch) — start of the chain. */
  contactId: string;
  contactName: string;
  /** The high-centrality hub at the far end. */
  targetId: string;
  targetName: string;
  targetDegree: number;
  hops: number;
  /**
   * The intermediary to lean on: the strongest-relationship node on the
   * chain (ties: closer to the hub, then lower id). Phase 3 turns this into
   * a ranked ask; v2 lists it without a written draft.
   */
  viaId: string;
  viaName: string;
  viaRelationshipScore: number | null;
  /** Full chain, contact → … → target. */
  chain: Array<{ contactId: string; fullName: string }>;
}

export interface NetworkGraph {
  generatedAt: string;
  totalContacts: number;
  /** Live contacts touched by a qualifying edge. */
  nodes: number;
  /** Qualifying edge count. */
  edges: number;
  /** Share of the network covered by at least one edge, 0–1. */
  coverage: number;
  /** Pending candidates the owner hasn't confirmed (excluded from analysis by default). */
  pendingCandidates: number;
  /** Dropped edge rows (endpoint soft-deleted/missing or self-edge). */
  dangling: number;
  /** Non-null when the graph was too large to analyze; sections are empty then. */
  degraded: { reason: string; edges: number; maxEdges: number } | null;
  communities: CommunitiesInfo;
  centrality: CentralityInfo;
  components: GraphComponents;
  avgPathLength: AvgPathLength;
  warmIntros: WarmIntroCandidate[];
}

/** Union-find over the undirected simple adjacency. */
export function componentsOf(graph: LoadedGraph): GraphComponents {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    parent.set(id, id);
    size.set(id, 1);
  }
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const [id, neighbors] of graph.neighbors) {
    for (const other of neighbors) {
      if (other < id) continue; // collapse each undirected pair once
      const ra = find(id);
      const rb = find(other);
      if (ra === rb) continue;
      const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
      parent.set(drop, keep);
      size.set(keep, (size.get(keep) ?? 1) + (size.get(drop) ?? 1));
      size.delete(drop);
    }
  }
  const sizes = Array.from(size.values()).sort((a, b) => b - a);
  const largest = sizes[0] ?? 0;
  return {
    count: sizes.length,
    largestSize: largest,
    outsideLargest: graph.nodes.size - largest,
  };
}

/** Exact mean shortest path over reachable unordered pairs, within the node budget. */
export function avgPathLengthOf(
  graph: LoadedGraph,
  maxNodes: number,
): AvgPathLength {
  const n = graph.nodes.size;
  if (n < 3) {
    return {
      value:
        n === 2 &&
        graph.neighbors.get(Array.from(graph.nodes.keys())[0]!)?.length
          ? 1
          : null,
      basis: "exact",
      note: null,
    };
  }
  if (n > maxNodes) {
    return {
      value: null,
      basis: "skipped",
      note: `avg path length skipped: ${n} nodes exceeds the ${maxNodes}-node exact-BFS budget`,
    };
  }
  let total = 0;
  let pairs = 0;
  for (const start of graph.nodes.keys()) {
    const dist = new Map<string, number>([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      const dv = dist.get(v)!;
      for (const w of graph.neighbors.get(v) ?? []) {
        if (dist.has(w)) continue;
        dist.set(w, dv + 1);
        queue.push(w);
      }
    }
    for (const [other, d] of dist) {
      if (other === start || other > start) continue; // count each unordered pair once
      total += d;
      pairs++;
    }
  }
  if (pairs === 0) return { value: null, basis: "exact", note: null };
  return {
    value: Math.round((total / pairs) * 100) / 100,
    basis: "exact",
    note: null,
  };
}

/**
 * Warm-intro candidates: hub (high degree) ↔ contact pairs with NO direct
 * edge where a path of 2..maxDepth hops exists. One candidate per (contact,
 * hub); ranked by hub degree, then shorter chains, then the via's tie
 * strength. Pure over a LoadedGraph — exported for tests.
 */
export function warmIntrosOf(
  graph: LoadedGraph,
  maxDepth: number,
  limit: number,
): WarmIntroCandidate[] {
  if (graph.nodes.size < 3 || graph.edges.length === 0) return [];
  const degree = (id: string): number => graph.neighbors.get(id)?.length ?? 0;
  const hubEntries = Array.from(graph.nodes.keys())
    .map((id) => ({ id, degree: degree(id) }))
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
    .slice(0, limit);

  const direct = new Map<string, Set<string>>();
  for (const [id, neighbors] of graph.neighbors)
    direct.set(id, new Set(neighbors));

  const scoreOf = (id: string): number =>
    graph.nodes.get(id)?.relationshipScore ?? 0;
  const out: WarmIntroCandidate[] = [];

  for (const { id: hub, degree: hubDegree } of hubEntries) {
    // Layered BFS from the hub; among equal-length chains the parent chosen
    // is the strongest-tie neighbor (ties: lower id), so reconstructed
    // chains run through contacts the owner can lean on. Layer-by-layer
    // promotion keeps every stored parent on a shortest path.
    const dist = new Map<string, number>([[hub, 0]]);
    const parent = new Map<string, string>();
    let frontier = [hub];
    let d = 0;
    while (frontier.length > 0 && d < maxDepth) {
      d++;
      const best = new Map<string, string>(); // w → chosen parent this layer
      for (const v of frontier) {
        for (const w of graph.neighbors.get(v) ?? []) {
          if (dist.has(w)) continue;
          const cur = best.get(w);
          if (
            cur === undefined ||
            scoreOf(v) > scoreOf(cur) ||
            (scoreOf(v) === scoreOf(cur) && v < cur)
          ) {
            best.set(w, v);
          }
        }
      }
      frontier = Array.from(best.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([w, p]) => {
          dist.set(w, d);
          parent.set(w, p);
          return w;
        });
    }
    for (const [contact, hops] of Array.from(dist.entries()).sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      if (contact === hub || hops < 2 || hops > maxDepth) continue;
      if (direct.get(hub)?.has(contact)) continue; // "no direct edge" rule
      const chain: string[] = [contact];
      let cur = contact;
      while (cur !== hub) {
        cur = parent.get(cur)!;
        chain.push(cur);
      }
      const inner = chain.slice(1, -1);
      const position = new Map<string, number>();
      chain.forEach((id, i) => position.set(id, i));
      let via = inner[0]!;
      for (const c of inner) {
        // strongest tie wins; ties resolve toward the hub (the ask has to
        // reach the hub), then it stays deterministic.
        const better =
          scoreOf(c) > scoreOf(via) ||
          (scoreOf(c) === scoreOf(via) &&
            (position.get(c) ?? 0) > (position.get(via) ?? 0));
        if (better) via = c;
      }
      out.push({
        contactId: contact,
        contactName: graph.nodes.get(contact)?.fullName ?? contact,
        targetId: hub,
        targetName: graph.nodes.get(hub)?.fullName ?? hub,
        targetDegree: hubDegree,
        hops,
        viaId: via,
        viaName: graph.nodes.get(via)?.fullName ?? via,
        viaRelationshipScore: graph.nodes.get(via)?.relationshipScore ?? null,
        chain: chain.map((id) => ({
          contactId: id,
          fullName: graph.nodes.get(id)?.fullName ?? id,
        })),
      });
    }
  }

  return out
    .sort(
      (a, b) =>
        b.targetDegree - a.targetDegree ||
        a.hops - b.hops ||
        (b.viaRelationshipScore ?? -1) - (a.viaRelationshipScore ?? -1) ||
        (a.contactId < b.contactId ? -1 : 1) ||
        (a.targetId < b.targetId ? -1 : 1),
    )
    .slice(0, limit);
}

/** The one call surfaces make for "the graph story": stats + all sections. */
export async function getNetworkGraph(
  conn: SqliteConn | PgConn,
  opts: GraphAnalysisOptions = {},
): Promise<NetworkGraph> {
  const resolved = resolveGraphAnalysisOptions(opts);
  const graph = await loadGraph(conn, opts);
  const pendingCandidates = await countEdges(
    conn,
    { status: "pending" },
    opts.scope,
  );

  const base = {
    generatedAt: resolved.now.toISOString(),
    totalContacts: graph.stats.totalContacts,
    nodes: graph.stats.nodes,
    edges: graph.stats.edges,
    coverage:
      graph.stats.totalContacts > 0
        ? Math.round((graph.stats.nodes / graph.stats.totalContacts) * 1000) /
          1000
        : 0,
    pendingCandidates,
    dangling: graph.stats.dangling,
  };

  if (graph.stats.edges > resolved.limits.maxEdges) {
    return {
      ...base,
      degraded: {
        reason: `graph has ${graph.stats.edges} edges — analysis is capped at ${resolved.limits.maxEdges}; attribute clusters in the Clusters section still work`,
        edges: graph.stats.edges,
        maxEdges: resolved.limits.maxEdges,
      },
      communities: {
        modularity: 0,
        count: 0,
        top: [],
        nodes: graph.stats.nodes,
        edges: graph.stats.edges,
      },
      centrality: {
        betweennessComputed: false,
        skippedReason: "skipped with the degraded graph",
        top: [],
      },
      components: { count: 0, largestSize: 0, outsideLargest: 0 },
      avgPathLength: { value: null, basis: "skipped", note: "degraded graph" },
      warmIntros: [],
    };
  }

  const empty: CommunitiesInfo = {
    modularity: 0,
    count: 0,
    top: [],
    nodes: graph.stats.nodes,
    edges: graph.stats.edges,
  };
  if (graph.nodes.size === 0) {
    return {
      ...base,
      degraded: null,
      communities: empty,
      centrality: { betweennessComputed: true, skippedReason: null, top: [] },
      components: { count: 0, largestSize: 0, outsideLargest: 0 },
      avgPathLength: { value: null, basis: "exact", note: null },
      warmIntros: [],
    };
  }

  const communitiesInfo = communitiesOf(
    graph,
    louvain(graph),
    resolved.limits.communityMembers,
  );
  return {
    ...base,
    degraded: null,
    communities: {
      ...communitiesInfo,
      top: communitiesInfo.top.slice(0, resolved.limit),
    },
    centrality: centralityOf(graph, opts),
    components: componentsOf(graph),
    avgPathLength: avgPathLengthOf(
      graph,
      resolved.limits.avgPathLengthMaxNodes,
    ),
    warmIntros: warmIntrosOf(graph, resolved.maxDepth, resolved.limit),
  };
}
