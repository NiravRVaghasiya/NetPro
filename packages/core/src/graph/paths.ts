// packages/core/src/graph/paths.ts
//
// Warm-intro pathfinder — BFS over `edges` for the shortest introduction
// chain between two contacts (v2.0 plan §Phase 2).
//
// Traversal rules (the direction rule is pathfinder-only; centrality stays
// undirected):
//   * A `bidirectional: true` edge is traversable both ways; a
//     bidirectional=false edge is traversable from source → target only.
//   * Only qualifying edges load at all: confirmed (or opted-in pending),
//     relation filter, min-confidence — see analysis.ts.
//   * Self-edges and edges touching missing/soft-deleted contacts are
//     dropped in loadGraph, so paths never walk through a ghost.
// Determinism: neighbors are explored in sorted order and equal-length
// alternatives are enumerated stably, so repeated runs produce byte-identical
// output for identical inputs.
import type { SqliteConn, PgConn } from "@netpro/db";
import { getContactById } from "../ai/resolve-contact";
import {
  GRAPH_ANALYSIS_LIMITS,
  loadGraph,
  type GraphAnalysisOptions,
  type LoadedGraph,
  resolveGraphAnalysisOptions,
} from "./analysis";
import { GraphError } from "./types";

export interface PathHopMeta {
  relations: string[];
  minConfidence: number;
  minStrength: number;
  /** True when only one direction of the pair exists in the analyzed set. */
  oneWay: boolean;
}

export interface IntroPathNode {
  contactId: string;
  fullName: string;
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  /** Recency of the owner's last recorded touch with this contact (v2.0 Phase 3). */
  lastInteraction: string | null;
  /** The edge that brought us here, from the previous node (null for the origin). */
  via: PathHopMeta | null;
}

export interface IntroPath {
  /** Number of edges traversed (1 = direct connection, no intermediary). */
  hops: number;
  /** Full chain including endpoints, origin first. */
  path: IntroPathNode[];
  /** Nodes strictly between origin and target, in traversal order. */
  intermediaries: IntroPathNode[];
}

export interface FindIntroPathsResult {
  found: boolean;
  originId: string;
  targetId: string;
  maxDepth: number;
  /** All returned paths have the same (shortest) length; up to `k` of them. */
  paths: IntroPath[];
  /** True when no path exists at all within maxDepth (paths may still be [] for other reasons). */
  unreachable: boolean;
}

/**
 * BFS shortest paths in a LoadedGraph (directed traversal per the bidirectional
 * rule). Returns up to `k` distinct shortest paths as id chains. Pure — no DB.
 */
export function shortestPaths(
  graph: LoadedGraph,
  originId: string,
  targetId: string,
  maxDepth: number,
  k = 1,
): string[][] {
  if (originId === targetId) return [];
  if (!graph.nodes.has(originId) || !graph.nodes.has(targetId)) return [];

  const limit = Math.max(1, Math.min(k, GRAPH_ANALYSIS_LIMITS.maxAlternatives));
  // pred[w] holds every predecessor one hop closer to the origin; equal-length
  // alternatives are enumerated from it, with bounded stored work per node so
  // pathological layered graphs stay linear.
  const dist = new Map<string, number>([[originId, 0]]);
  const pred = new Map<string, string[]>();
  let frontier: string[] = [originId];
  let depth = 0;
  let reached = false;
  while (frontier.length > 0 && depth < maxDepth && !reached) {
    depth++;
    const next: string[] = [];
    const seen = new Set<string>();
    for (const v of frontier) {
      for (const edge of graph.out.get(v) ?? []) {
        const w = edge.targetId;
        const known = dist.get(w);
        if (known === undefined) {
          dist.set(w, depth);
          pred.set(w, [v]);
          if (w === targetId) reached = true; // finish this layer to collect equal-length preds
          if (!seen.has(w)) {
            seen.add(w);
            if (w !== targetId) next.push(w);
          }
        } else if (known === depth) {
          const list = pred.get(w) ?? [];
          if (list.length < 16 && !list.includes(v)) pred.set(w, [...list, v]);
        }
      }
    }
    frontier = next;
  }
  if (!reached) return [];

  // Walk back through predecessors, breadth-wise, keeping the lexicographically
  // first `limit` chains (deterministic; `pred` lists are built in sorted order).
  const chains: string[][] = [];
  const queue: string[][] = [[targetId]];
  while (queue.length > 0 && chains.length < limit) {
    const chain = queue.shift()!;
    const head = chain[0]!;
    if (head === originId) {
      chains.push(chain);
      continue;
    }
    for (const p of (pred.get(head) ?? []).slice().sort()) {
      queue.push([p, ...chain]);
    }
  }
  return chains.sort();
}

function hopMetaFor(graph: LoadedGraph, from: string, to: string): PathHopMeta {
  const forward = (graph.out.get(from) ?? []).filter((e) => e.targetId === to);
  const reverse = (graph.out.get(to) ?? []).filter((e) => e.targetId === from);
  const all = [...forward, ...reverse]; // labels collapse the pair; traversal used `forward`
  const relations = Array.from(new Set(all.map((e) => e.relation))).sort();
  return {
    relations,
    minConfidence: Math.min(...all.map((e) => e.confidence)),
    minStrength: Math.min(...all.map((e) => e.strength)),
    oneWay:
      forward.length > 0 &&
      forward.every((e) => !e.bidirectional) &&
      reverse.length === 0,
  };
}

function nodeFor(graph: LoadedGraph, id: string): IntroPathNode {
  const node = graph.nodes.get(id);
  return {
    contactId: id,
    fullName: node?.fullName ?? id,
    company: node?.company ?? null,
    role: node?.role ?? null,
    relationshipScore: node?.relationshipScore ?? null,
    lastInteraction: node?.lastInteraction ?? null,
    via: null,
  };
}

function decorate(graph: LoadedGraph, chain: string[]): IntroPath {
  const nodes = chain.map((id) => nodeFor(graph, id));
  for (let i = 1; i < nodes.length; i++) {
    nodes[i]!.via = hopMetaFor(graph, chain[i - 1]!, chain[i]!);
  }
  return {
    hops: chain.length - 1,
    path: nodes,
    intermediaries: nodes.slice(1, -1),
  };
}

/**
 * Find up to `k` shortest warm-intro chains between two live contacts.
 * `fromId`/`toId` accept exact ids only here; selector resolution
 * (email/name/prefix) stays in the surfaces that already do it.
 */
export async function findIntroPaths(
  conn: SqliteConn | PgConn,
  originId: string,
  targetId: string,
  opts: GraphAnalysisOptions & { k?: number } = {},
): Promise<FindIntroPathsResult> {
  const from = originId.trim();
  const to = targetId.trim();
  if (!from || !to)
    throw new GraphError(
      "invalid_input",
      "Both origin and target contact ids are required.",
    );
  if (from === to)
    throw new GraphError(
      "invalid_input",
      "Origin and target are the same contact.",
    );
  for (const id of [from, to]) {
    const contact = await getContactById(conn, id, opts.scope);
    if (!contact) {
      throw new GraphError(
        "not_found",
        `No contact with id "${id}". Soft-deleted contacts cannot be linked.`,
      );
    }
  }

  const { maxDepth } = resolveGraphAnalysisOptions(opts);
  const graph = await loadGraph(conn, opts);
  const chains = shortestPaths(graph, from, to, maxDepth, opts.k ?? 1);
  if (chains.length === 0) {
    return {
      found: false,
      originId: from,
      targetId: to,
      maxDepth,
      paths: [],
      unreachable: true,
    };
  }
  return {
    found: true,
    originId: from,
    targetId: to,
    maxDepth,
    paths: chains.map((chain) => decorate(graph, chain)),
    unreachable: false,
  };
}
