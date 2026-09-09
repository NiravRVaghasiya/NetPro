// packages/core/src/graph/analysis.ts
//
// Graph loading + analysis options for Phase 2 (communities, centrality,
// paths). The blueprint's graph analytics run on a small single-owner graph
// (hundreds–thousands of nodes), so the strategy mirrors analytics/metrics:
// one portable read pass over `edges` + the shared contacts projection, then
// pure-JS graph math. Same code on both dialects — no dialect-only SQL, no
// new runtime dependency.
//
// Trust rules inherited from Phase 1:
//   * `rejected` edges are NEVER loaded, whatever the filter.
//   * Inferred (`pending`) edges are excluded by default — analytics runs on
//     what the owner confirmed; `status: 'all'` opts into pending rows.
//   * Edges touching a soft-deleted (or missing) contact are dropped.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { EDGE_RELATIONS, GraphError, type EdgeRelation } from "./types";
import { workspacePredicate, type WorkspaceScope } from "../workspaces/scope";

/** Hard ceilings from the v2.0 plan (risk table), overridable only for tests. */
export const GRAPH_ANALYSIS_LIMITS = {
  /** Above this edge count, full graph analytics are skipped (degrade to attribute clusters). */
  maxEdges: 50_000,
  /** Brandes betweenness is O(V·E); beyond this node count it is skipped. */
  betweennessMaxNodes: 1_500,
  /** Exact all-pairs BFS average path length beyond this node count is skipped. */
  avgPathLengthMaxNodes: 600,
  /** Pathfinder hop budget: default 4 (blueprint reference), hard cap 8. */
  maxDepthDefault: 4,
  maxDepthCap: 8,
  /** Max candidates per list-shaped section. */
  listLimitDefault: 10,
  listLimitCap: 50,
  /** Members recorded per community (list surfaces show `size`, capped here). */
  communityMembers: 25,
  /** k in "k shortest paths of equal length". */
  maxAlternatives: 5,
} as const;

export interface GraphLimits {
  maxEdges: number;
  betweennessMaxNodes: number;
  avgPathLengthMaxNodes: number;
  communityMembers: number;
}

export interface GraphAnalysisOptions {
  /** Which confirmation states enter the graph. `rejected` is never included. Default `'confirmed'`. */
  status?: "confirmed" | "pending" | "all";
  /** Restrict to one provenance relation (whitelist). */
  relation?: EdgeRelation | string;
  /** Edges must carry at least this confidence (0–1). Default 0. */
  minConfidence?: number;
  /** Max rows per list section (default 10, cap 50). */
  limit?: number;
  /** BFS cutoff in hops for the pathfinder (default 4, cap 8). */
  maxDepth?: number;
  /** Injected clock for deterministic output. */
  now?: Date;
  /** Internal/test seam: tighten the caps (never raise past the defaults). */
  limits?: Partial<GraphLimits>;
  /** v3.0 Phase 2 — workspace scope; absent = bootstrap workspace. */
  scope?: WorkspaceScope;
}

export interface ResolvedGraphAnalysisOptions {
  statuses: string[];
  relation: EdgeRelation | null;
  minConfidence: number;
  limit: number;
  maxDepth: number;
  now: Date;
  limits: GraphLimits;
}

export function resolveGraphAnalysisOptions(
  opts: GraphAnalysisOptions = {},
): ResolvedGraphAnalysisOptions {
  let statuses: string[];
  if (opts.status === undefined || opts.status === "confirmed") {
    statuses = ["confirmed"];
  } else if (opts.status === "all") {
    statuses = ["confirmed", "pending"];
  } else if (opts.status === "pending") {
    statuses = ["pending"];
  } else {
    throw new GraphError(
      "invalid_input",
      `Unknown edge status "${String(opts.status)}".`,
    );
  }

  let relation: EdgeRelation | null = null;
  if (
    opts.relation !== undefined &&
    opts.relation !== null &&
    opts.relation !== ""
  ) {
    if (!(EDGE_RELATIONS as readonly string[]).includes(opts.relation)) {
      throw new GraphError(
        "invalid_input",
        `Unknown relation "${String(opts.relation)}". Expected one of: ${EDGE_RELATIONS.join(", ")}.`,
      );
    }
    relation = opts.relation as EdgeRelation;
  }

  const minConfidence = opts.minConfidence ?? 0;
  if (
    !Number.isFinite(minConfidence) ||
    minConfidence < 0 ||
    minConfidence > 1
  ) {
    throw new GraphError(
      "invalid_input",
      "minConfidence must be a number between 0 and 1.",
    );
  }

  const limit = Math.min(
    Math.max(
      Math.trunc(opts.limit ?? GRAPH_ANALYSIS_LIMITS.listLimitDefault),
      1,
    ),
    GRAPH_ANALYSIS_LIMITS.listLimitCap,
  );
  const maxDepth = Math.min(
    Math.max(
      Math.trunc(opts.maxDepth ?? GRAPH_ANALYSIS_LIMITS.maxDepthDefault),
      1,
    ),
    GRAPH_ANALYSIS_LIMITS.maxDepthCap,
  );

  const limits: GraphLimits = {
    maxEdges: Math.min(
      opts.limits?.maxEdges ?? GRAPH_ANALYSIS_LIMITS.maxEdges,
      GRAPH_ANALYSIS_LIMITS.maxEdges,
    ),
    betweennessMaxNodes: Math.min(
      opts.limits?.betweennessMaxNodes ??
        GRAPH_ANALYSIS_LIMITS.betweennessMaxNodes,
      GRAPH_ANALYSIS_LIMITS.betweennessMaxNodes,
    ),
    avgPathLengthMaxNodes: Math.min(
      opts.limits?.avgPathLengthMaxNodes ??
        GRAPH_ANALYSIS_LIMITS.avgPathLengthMaxNodes,
      GRAPH_ANALYSIS_LIMITS.avgPathLengthMaxNodes,
    ),
    communityMembers:
      opts.limits?.communityMembers ?? GRAPH_ANALYSIS_LIMITS.communityMembers,
  };

  return {
    statuses,
    relation,
    minConfidence,
    limit,
    maxDepth,
    now: opts.now ?? new Date(),
    limits,
  };
}

/** One live contact as projected for analysis. */
export type GraphNode = GraphContactRow;

/** An analyzed edge (already filtered by status/relation/confidence). */
export interface AnalyzedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  strength: number;
  confidence: number;
  bidirectional: boolean;
}

/**
 * In-memory graph. `neighbors` is the undirected simple adjacency used by
 * Louvain/centrality (symmetric pairs collapsed, sorted for determinism);
 * `out` is the directed adjacency used by the pathfinder — `bidirectional:
 * false` rows traverse one way only.
 */
export interface LoadedGraph {
  /** Live contacts incident to at least one qualifying edge, insertion-ordered by id. */
  nodes: Map<string, GraphNode>;
  neighbors: Map<string, string[]>;
  /** Directed out-edges per node, sorted by (target, id). */
  out: Map<string, AnalyzedEdge[]>;
  /** Qualifying edges, sorted by id for deterministic reruns. */
  edges: AnalyzedEdge[];
  stats: {
    totalContacts: number;
    /** Live contacts touched by at least one qualifying edge. */
    nodes: number;
    /** Qualifying edge rows. */
    edges: number;
    /** Dropped because a endpoint was missing or soft-deleted. */
    dangling: number;
    /** Nodes with no qualifying edge at all (network coverage). */
    uncoveredContacts: number;
  };
}

export interface EdgeReadRow {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  strength: number | null;
  confidence: number | null;
  bidirectional: boolean | null;
}

/**
 * Load + validate everything graph analytics need: one filtered pass over
 * `edges` and the shared contacts projection, joined in pure JS.
 */
export async function loadGraph(
  conn: SqliteConn | PgConn,
  options: GraphAnalysisOptions = {},
): Promise<LoadedGraph> {
  const resolved = resolveGraphAnalysisOptions(options);
  const rows = await readEdgeRows(conn, resolved, options.scope);
  const contacts = await readLiveContacts(conn, options.scope);
  return buildGraph(rows, contacts);
}

/**
 * The live-contact projection for the graph: analytics' seven columns plus
 * `fullName` (labels need names, and names must come from live rows so a
 * soft-deleted endpoint never appears as a node).
 */
async function readLiveContacts(
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<GraphContactRow[]> {
  if (conn.dialect === "sqlite") {
    const c = conn.schema.contacts;
    return conn.db
      .select({
        id: c.id,
        fullName: c.fullName,
        company: c.company,
        industry: c.industry,
        role: c.role,
        relationshipScore: c.relationshipScore,
        lastInteraction: c.lastInteraction,
        createdAt: c.createdAt,
      })
      .from(c)
      .where(
        and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)),
      );
  }
  const c = conn.schema.contacts;
  return conn.db
    .select({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      industry: c.industry,
      role: c.role,
      relationshipScore: c.relationshipScore,
      lastInteraction: c.lastInteraction,
      createdAt: c.createdAt,
    })
    .from(c)
    .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)));
}

export interface GraphContactRow {
  id: string;
  fullName: string;
  company: string | null;
  industry: string | null;
  role: string | null;
  relationshipScore: number | null;
  lastInteraction: string | null;
  createdAt: string;
}

/**
 * `rejected` rows are filtered in SQL; nothing else about trust is inferred
 * here. Drizzle's typed builders need dialect-narrowed tables (same pattern
 * as analytics/metrics.ts); the queries themselves are ANSI-portable.
 */
async function readEdgeRows(
  conn: SqliteConn | PgConn,
  resolved: ResolvedGraphAnalysisOptions,
  scope?: WorkspaceScope,
): Promise<EdgeReadRow[]> {
  if (conn.dialect === "sqlite") {
    const e = conn.schema.edges;
    const where = and(
      inArray(e.status, resolved.statuses),
      workspacePredicate(scope, e.workspaceId),
      resolved.relation === null
        ? undefined
        : eq(e.relation, resolved.relation),
      sql`${e.confidence} >= ${resolved.minConfidence}`,
    );
    return (await conn.db
      .select({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        relation: e.relation,
        strength: e.strength,
        confidence: e.confidence,
        bidirectional: e.bidirectional,
      })
      .from(e)
      .where(where)
      .orderBy(e.id)) as EdgeReadRow[];
  }
  const e = conn.schema.edges;
  const where = and(
    inArray(e.status, resolved.statuses),
    workspacePredicate(scope, e.workspaceId),
    resolved.relation === null ? undefined : eq(e.relation, resolved.relation),
    sql`${e.confidence} >= ${resolved.minConfidence}`,
  );
  return (await conn.db
    .select({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      relation: e.relation,
      strength: e.strength,
      confidence: e.confidence,
      bidirectional: e.bidirectional,
    })
    .from(e)
    .where(where)
    .orderBy(e.id)) as EdgeReadRow[];
}

/** Pure join — exported for tests. Both dialects read identical row shapes. */
export function buildGraph(
  edgeRows: EdgeReadRow[],
  contacts: GraphContactRow[],
): LoadedGraph {
  const live = new Map<string, GraphNode>();
  for (const c of contacts) {
    live.set(c.id, { ...c });
  }

  const nodes = new Map<string, GraphNode>();
  const neighbors = new Map<string, Set<string>>();
  const out = new Map<string, AnalyzedEdge[]>();
  const edges: AnalyzedEdge[] = [];
  let dangling = 0;

  for (const row of edgeRows) {
    const a = live.get(row.sourceId);
    const b = live.get(row.targetId);
    if (!a || !b || row.sourceId === row.targetId) {
      // Soft-deleted endpoint, missing row, or a defensive self-edge.
      if (row.sourceId !== row.targetId) dangling++;
      continue;
    }
    const edge: AnalyzedEdge = {
      id: row.id,
      sourceId: row.sourceId,
      targetId: row.targetId,
      relation: row.relation,
      strength: row.strength ?? 0.5,
      confidence: row.confidence ?? 1,
      bidirectional: row.bidirectional !== false,
    };
    edges.push(edge);

    nodes.set(a.id, a);
    nodes.set(b.id, b);
    // Undirected adjacency is ALWAYS symmetric: a one-way row still proves
    // the two people are connected, which is what clustering/centrality ask.
    // `bidirectional` only gates the pathfinder's traversal (`out`).
    for (const pair of [
      [a.id, b.id],
      [b.id, a.id],
    ] as const) {
      let n = neighbors.get(pair[0]);
      if (!n) neighbors.set(pair[0], (n = new Set()));
      n.add(pair[1]);
    }
    for (const [from, to] of edge.bidirectional
      ? ([
          [a.id, b.id],
          [b.id, a.id],
        ] as const)
      : ([[a.id, b.id]] as const)) {
      let o = out.get(from);
      if (!o) out.set(from, (o = []));
      // Store the traversal-oriented copy so `edge.targetId` always names
      // the node we'd walk INTO (a shared row would self-point backward).
      o.push(
        from === edge.sourceId && to === edge.targetId
          ? edge
          : { ...edge, sourceId: from, targetId: to },
      );
    }
  }

  edges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const sortedNeighbors = new Map<string, string[]>();
  for (const [id, set] of neighbors) {
    sortedNeighbors.set(id, Array.from(set).sort());
  }
  for (const list of out.values()) {
    list.sort((x, y) =>
      x.targetId < y.targetId
        ? -1
        : x.targetId > y.targetId
          ? 1
          : x.id < y.id
            ? -1
            : 1,
    );
  }
  // Insert in sorted id order so iteration is deterministic everywhere.
  const orderedNodes = new Map<string, GraphNode>();
  for (const id of Array.from(nodes.keys()).sort()) {
    orderedNodes.set(id, nodes.get(id)!);
  }

  return {
    nodes: orderedNodes,
    neighbors: sortedNeighbors,
    out,
    edges,
    stats: {
      totalContacts: contacts.length,
      nodes: orderedNodes.size,
      edges: edges.length,
      dangling,
      uncoveredContacts: contacts.length - orderedNodes.size,
    },
  };
}
