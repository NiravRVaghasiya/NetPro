// packages/core/src/graph/centrality.ts
//
// Degree + betweenness centrality over the confirmed graph.
//
// Semantics (documented choice, v2.0 plan §Phase 2):
//   * Centrality treats the network as an UNDIRECTED SIMPLE graph: every
//     qualifying edge counts once regardless of `bidirectional` (it answers
//     "how connected is this person?", not "can I reach them?"). The
//     direction rule belongs to the pathfinder only.
//   * v2 is unweighted — Brandes on hop counts. Weighting by
//     strength × confidence is explicitly later-phase work.
//   * Betweenness is O(V·E); above `limits.betweennessMaxNodes` nodes it is
//     skipped and reported as `null` per contact, so the dashboard stays
//     inside its budget on large graphs.
import { loadGraph, type GraphAnalysisOptions, type LoadedGraph, resolveGraphAnalysisOptions } from './analysis';
import type { SqliteConn, PgConn } from '@netpro/db';

export interface DegreeEntry {
  contactId: string;
  /** Unique neighbors in the analyzed (undirected, simple) graph. */
  degree: number;
  /** degree / (n − 1); 0 when n < 2. */
  normalized: number;
}

/** Degree centrality over an in-memory graph, sorted by degree desc then id asc. */
export function degreeCentrality(graph: LoadedGraph): DegreeEntry[] {
  const n = graph.nodes.size;
  const rows: DegreeEntry[] = [];
  for (const [id, neighbors] of graph.neighbors) {
    rows.push({ contactId: id, degree: neighbors.length, normalized: n > 1 ? neighbors.length / (n - 1) : 0 });
  }
  return rows.sort((a, b) => b.degree - a.degree || (a.contactId < b.contactId ? -1 : 1));
}

export interface BetweennessEntry {
  contactId: string;
  /** Raw (unnormalized) betweenness — number of shortest paths through v, each undirected pair counted once. */
  raw: number;
  /** raw / ((n−1)(n−2)/2), clamped to [0,1]; 0 when n < 3. */
  normalized: number;
}

/**
 * Brandes (2001) betweenness on the undirected simple graph.
 * Returns null when the graph exceeds `opts.limits.betweennessMaxNodes`
 * (paired with a `reason`) so callers can degrade honestly.
 */
export function brandesBetweenness(
  graph: LoadedGraph,
  opts: GraphAnalysisOptions = {}
): { entries: BetweennessEntry[] | null; skippedReason: string | null } {
  const { limits } = resolveGraphAnalysisOptions(opts);
  const ids = Array.from(graph.nodes.keys()); // sorted
  const n = ids.length;
  if (n > limits.betweennessMaxNodes) {
    return {
      entries: null,
      skippedReason: `betweenness skipped: ${n} nodes exceeds the ${limits.betweennessMaxNodes}-node budget (O(V·E)); degree still reported`,
    };
  }
  if (n === 0) return { entries: [], skippedReason: null };

  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const adj: number[][] = ids.map(() => []);
  for (const [id, neighbors] of graph.neighbors) {
    const i = index.get(id)!;
    for (const other of neighbors) adj[i]!.push(index.get(other)!);
  }
  for (const row of adj) row.sort((a, b) => a - b);

  const cb = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    const delta = new Array<number>(n).fill(0);
    const stack: number[] = [];
    const queue: number[] = [s];
    sigma[s] = 1;
    dist[s] = 0;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      stack.push(v);
      for (const w of adj[v]!) {
        if (dist[w] === -1) {
          dist[w] = dist[v]! + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v]! + 1) sigma[w] = sigma[w]! + sigma[v]!;
      }
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i]!;
      for (const v of adj[w]!) {
        if (dist[v] === dist[w]! - 1) {
          delta[v] = delta[v]! + (sigma[v]! / sigma[w]!) * (1 + delta[w]!);
        }
      }
      if (w !== s) cb[w] = cb[w]! + delta[w]!;
    }
  }
  // Undirected: every pair was counted from both ends.
  const norm = n >= 3 ? (n - 1) * (n - 2) / 2 : 1;
  const entries: BetweennessEntry[] = ids.map((id, i) => ({
    contactId: id,
    raw: Math.round((cb[i]! / 2) * 1e6) / 1e6,
    normalized: n >= 3 ? Math.min(1, Math.max(0, cb[i]! / 2 / norm)) : 0,
  }));
  return { entries, skippedReason: null };
}

export interface CentralityInfo {
  betweennessComputed: boolean;
  /** Why betweenness was skipped, when it was. */
  skippedReason: string | null;
  /** Top contacts by degree, ties by betweenness desc then id asc. */
  top: Array<{
    contactId: string;
    fullName: string;
    degree: number;
    normalized: number;
    /** null when betweenness was skipped. */
    betweenness: number | null;
  }>;
}

/** `getCentrality()` per the v2.0 plan: per-contact centrality scores for a live graph. */
export async function getCentrality(
  conn: SqliteConn | PgConn,
  opts: GraphAnalysisOptions = {}
): Promise<CentralityInfo> {
  const graph = await loadGraph(conn, opts);
  return centralityOf(graph, opts);
}

/** Pure half of getCentrality — exported for tests and for getNetworkGraph (one load). */
export function centralityOf(graph: LoadedGraph, opts: GraphAnalysisOptions = {}): CentralityInfo {
  const { limit } = resolveGraphAnalysisOptions(opts);
  const degree = degreeCentrality(graph);
  const { entries, skippedReason } = brandesBetweenness(graph, opts);
  const betweenness = entries ? new Map(entries.map((e) => [e.contactId, e])) : null;

  const ranked = degree
    .slice()
    .sort(
      (a, b) =>
        b.degree - a.degree ||
        (betweenness ? (betweenness.get(b.contactId)?.normalized ?? 0) - (betweenness.get(a.contactId)?.normalized ?? 0) : 0) ||
        (a.contactId < b.contactId ? -1 : 1)
    );

  return {
    betweennessComputed: betweenness !== null,
    skippedReason,
    top: ranked.slice(0, limit).map((d) => ({
      contactId: d.contactId,
      fullName: graph.nodes.get(d.contactId)?.fullName ?? d.contactId,
      degree: d.degree,
      normalized: Math.round(d.normalized * 1000) / 1000,
      betweenness: betweenness ? Math.round((betweenness.get(d.contactId)?.normalized ?? 0) * 1000) / 1000 : null,
    })),
  };
}
