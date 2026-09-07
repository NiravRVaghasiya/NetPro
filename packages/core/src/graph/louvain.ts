// packages/core/src/graph/louvain.ts
//
// Louvain modularity optimization, in pure TS.
//
// Decision (v2.0 plan, open question #1): the house posture is "pure TS +
// fetch, offline tests, no new runtime deps" — vendoring graphology for one
// algorithm fails the cost/benefit at single-owner scale (hundreds–thousands
// of nodes). This is the classic two-phase algorithm: local moves until a
// full sweep is idle, then contract communities into a weighted multigraph
// (internal weight becomes the super-node's self-loop) and repeat while
// modularity improves.
//
// Determinism: nodes are swept in sorted-id order and equal gains resolve to
// the lowest community index, so identical input graphs always produce
// identical partitions — the hand-computed tests rely on that.
//
// Conventions (classical Q):
//   adj is symmetric for i≠j; a self-loop stores its weight once at adj[i][i].
//   m   = Σ_{i<j} w_ij + Σ_i w_ii          (total edge weight)
//   k_i = Σ_{j≠i} w_ij + 2·w_ii            (self-loops count twice in degree)
//   L_c = internal weight of community c   (self-loops of members, once)
//   K_c = Σ_{i∈c} k_i
//   Q   = Σ_c [ L_c/m − (K_c/2m)² ]
import type { LoadedGraph } from './analysis';

export interface WeightedAdjacency {
  /** Node ids (sorted — the determinism anchor). */
  ids: string[];
  /** index → (neighbor index → summed weight), symmetric, self-loops stored once. */
  adj: Array<Map<number, number>>;
  /** Total edge weight (each undirected edge counted once, self-loops once). */
  m: number;
}

/**
 * Collapse a LoadedGraph into index-based weighted adjacency for Louvain.
 * Parallel relations between the same pair sum to one edge; self-edges are
 * dropped (addEdge forbids them; the filter keeps raw fixtures honest).
 */
export function toWeightedAdjacency(graph: LoadedGraph, weightOf?: (edge: AnalyzedEdgeLike) => number): WeightedAdjacency {
  const ids = Array.from(graph.nodes.keys()); // sorted by id in loadGraph
  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const adj: Array<Map<number, number>> = ids.map(() => new Map());
  let m = 0;
  for (const edge of graph.edges) {
    const a = index.get(edge.sourceId);
    const b = index.get(edge.targetId);
    if (a === undefined || b === undefined || a === b) continue;
    const w = weightOf ? weightOf(edge) : 1; // v2: unweighted (strength×confidence weighting is later-phase work)
    const [lo, hi] = a < b ? [a, b] : [b, a];
    adj[lo]!.set(hi, (adj[lo]!.get(hi) ?? 0) + w);
    adj[hi]!.set(lo, (adj[hi]!.get(lo) ?? 0) + w);
    m += w;
  }
  return { ids, adj, m };
}

interface AnalyzedEdgeLike {
  sourceId: string;
  targetId: string;
  strength: number;
  confidence: number;
}

/** degree with self-loops counted twice — the convention the Q formula expects. */
function weightedDegree(row: Map<number, number>, i: number): number {
  let k = 0;
  for (const [j, w] of row) k += j === i ? 2 * w : w;
  return k;
}

/** Σ L_c/m − (K_c/2m)² for a membership array over a weighted adjacency (0 for a weight-less graph). */
export function modularityOf(adj: WeightedAdjacency['adj'], community: number[]): number {
  let m = 0;
  const L = new Map<number, number>();
  const K = new Map<number, number>();
  for (let i = 0; i < adj.length; i++) {
    const ci = community[i]!;
    K.set(ci, (K.get(ci) ?? 0) + weightedDegree(adj[i]!, i));
    for (const [j, w] of adj[i]!) {
      if (j < i) continue; // count each undirected edge once (self-loops included)
      m += w;
      if (community[j] === ci) L.set(ci, (L.get(ci) ?? 0) + w);
    }
  }
  if (m === 0) return 0;
  let q = 0;
  for (const [c, l] of L) {
    const frac = (K.get(c) ?? 0) / (2 * m);
    q += l / m - frac * frac;
  }
  for (const [c, kSum] of K) {
    if (L.has(c)) continue;
    const frac = kSum / (2 * m);
    q -= frac * frac;
  }
  return q;
}

/**
 * Phase 1 for one level: repeatedly move nodes to a neighbor community while
 * the modularity gain is positive. Gain(i: A→B)·m = (w_iB − w_iA) −
 * k_i·(K_B − K_A + k_i)/(2m). Returns the membership array.
 */
function localMoves(adj: WeightedAdjacency['adj']): number[] {
  const n = adj.length;
  const community = n > 0 ? Array.from({ length: n }, (_, i) => i) : [];
  if (n === 0) return community;

  let m = 0;
  const k = new Array<number>(n).fill(0);
  const loop = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]!) {
      if (j < i) continue;
      m += w;
    }
  }
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]!) {
      if (j === i) loop[i]! += w; // counted once at adj[i][i], twice in k_i
      k[i]! += w;
    }
    k[i]! += loop[i]!;
  }
  if (m === 0) return community;

  const K = Array.from({ length: n }, (_, i) => k[i]!);

  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < n; i++) {
      const own = community[i]!;
      // Weight from i into each neighboring community (self-loops excluded:
      // they follow i to any community and cancel in the gain).
      const into = new Map<number, number>();
      for (const [j, w] of adj[i]!) {
        if (j === i) continue;
        const cj = community[j]!;
        into.set(cj, (into.get(cj) ?? 0) + w);
      }
      const wOwn = into.get(own) ?? 0;
      into.delete(own);

      let best = own;
      let bestGain = 0;
      for (const [c, wInto] of into) {
        const gain = (wInto - wOwn) - (k[i]! * (K[c]! - K[own]! + k[i]!)) / (2 * m);
        if (gain > bestGain + 1e-12 || (gain > 1e-12 && Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          bestGain = gain;
          best = c;
        }
      }
      if (best !== own) {
        K[own]! -= k[i]!;
        K[best]! += k[i]!;
        community[i] = best;
        moved = true;
      }
    }
  }
  return community;
}

/**
 * Phase 2 for one level: fold every community into one node. Cross weights
 * sum; a community's internal weight (edges + member self-loops) becomes the
 * super-node's self-loop, keeping m and every k invariant.
 */
function contract(adj: WeightedAdjacency['adj'], community: number[]): WeightedAdjacency['adj'] {
  const count = Math.max(...community, 0) + 1;
  const contracted: Array<Map<number, number>> = Array.from({ length: count }, () => new Map());
  for (let i = 0; i < adj.length; i++) {
    const ci = community[i]!;
    for (const [j, w] of adj[i]!) {
      if (j < i) continue; // each undirected edge (and self-loop) once
      const cj = community[j]!;
      if (ci === cj) {
        const row = contracted[ci]!;
        row.set(ci, (row.get(ci) ?? 0) + w);
      } else {
        contracted[ci]!.set(cj, (contracted[ci]!.get(cj) ?? 0) + w);
        contracted[cj]!.set(ci, (contracted[cj]!.get(ci) ?? 0) + w);
      }
    }
  }
  return contracted;
}

export interface LouvainResult {
  /** Node id → community index (0-based, contiguous, ordered by first member id). */
  membership: Map<string, number>;
  /** Classical modularity of the final partition (0 for an edge-less graph). */
  modularity: number;
  /** Community index → member ids (members sorted by id). */
  communities: string[][];
}

/**
 * Run Louvain over a loaded graph. Empty input yields an empty result;
 * `maxLevels` bounds the contraction loop (3 converges at single-owner scale
 * and keeps worst-case cost predictable).
 */
export function louvain(graph: LoadedGraph, maxLevels = 3): LouvainResult {
  const { ids, adj } = toWeightedAdjacency(graph);
  if (ids.length === 0) {
    return { membership: new Map(), modularity: 0, communities: [] };
  }

  let level = adj;
  const assignment: number[] = ids.map((_, i) => i); // original node → current super-node index
  for (let round = 0; round < maxLevels; round++) {
    const moved = localMoves(level);
    const changed = moved.some((c, i) => c !== i);
    for (let i = 0; i < assignment.length; i++) assignment[i] = moved[assignment[i]!]!;
    if (!changed) break; // local optimum — further contractions cannot help
    const next = contract(level, moved);
    if (next.length <= 1) break; // fully contracted into one community
    level = next;
  }

  // Re-label communities 0..k-1 in first-member order (ids are sorted).
  const relabel = new Map<number, number>();
  const membership = new Map<string, number>();
  const communities: string[][] = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = assignment[i]!;
    let c = relabel.get(raw);
    if (c === undefined) {
      c = relabel.size;
      relabel.set(raw, c);
      communities.push([]);
    }
    membership.set(ids[i]!, c);
    communities[c]!.push(ids[i]!);
  }
  const q = modularityOf(adj, ids.map((id) => membership.get(id)!));
  return { membership, modularity: q, communities };
}
