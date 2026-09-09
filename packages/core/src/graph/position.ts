// packages/core/src/graph/position.ts
//
// v2.0 Phase 3 — one contact's position in the graph, for the `/graph/<id>`
// page: centrality (degree + rank + betweenness), Louvain community,
// adjacency (including PENDING candidates so the confirmation flow has an
// entry point), reachability within the pathfinder budget, and the
// warm-intro suggestions this person appears in.
//
// Honesty rules (same posture as Phase 2):
//   * centrality/community run over the ANALYZED graph (default: confirmed
//     edges only); a contact with no qualifying edge is reported as such —
//     never as a zero-degree participant;
//   * betweenness is `null` + reason when the node budget skips it;
//   * above the 50k-edge cap the analysis sections are `degraded` and only
//     the adjacency list is returned (cheap indexed read — always works).
import { and, eq } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { getContactById } from "../ai/resolve-contact";
import {
  GRAPH_ANALYSIS_LIMITS,
  loadGraph,
  resolveGraphAnalysisOptions,
  type GraphAnalysisOptions,
} from "./analysis";
import { brandesBetweenness, degreeCentrality } from "./centrality";
import { communityLabel } from "./communities";
import { listEdges } from "./edges";
import { louvain } from "./louvain";
import { warmIntrosOf, type WarmIntroCandidate } from "./network";
import { GraphError } from "./types";
import { workspacePredicate } from "../workspaces/scope";

export interface GraphNeighborRow {
  edgeId: string;
  contactId: string;
  fullName: string;
  relation: string;
  status: string;
  confidence: number;
  strength: number;
  /** From THIS contact's perspective: 'both' for bidirectional rows. */
  direction: "both" | "out" | "in";
  context: string | null;
  updatedAt: string;
}

export interface ContactGraphPosition {
  contact: {
    id: string;
    fullName: string;
    company: string | null;
    role: string | null;
    relationshipScore: number | null;
    lastInteraction: string | null;
  };
  analyzed: { nodes: number; edges: number };
  /** Non-null when the full graph analysis was capped (see network.ts). */
  degraded: string | null;
  /** True when the contact participates in the analyzed graph at all. */
  inGraph: boolean;
  centrality: {
    degree: number | null;
    /** 1-based position in the degree ranking; null when not in graph. */
    degreeRank: number | null;
    /** Normalized betweenness; null when skipped or not in graph. */
    betweenness: number | null;
    betweennessNote: string | null;
  };
  community: { communityId: number; label: string; size: number } | null;
  /** Nodes reachable from this contact within maxDepth hops (undirected). */
  reachableWithinDepth: number;
  neighbors: GraphNeighborRow[];
  /** Warm-intro candidates (from the same algorithm as the dashboard) that involve this contact. */
  warmIntros: WarmIntroCandidate[];
}

/** Undirected BFS over `neighbors` from one node, bounded by maxDepth. */
function reachableWithin(
  graphNeighbors: Map<string, string[]>,
  start: string,
  maxDepth: number,
): number {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    const dv = dist.get(v)!;
    if (dv >= maxDepth) continue;
    for (const w of graphNeighbors.get(v) ?? []) {
      if (dist.has(w)) continue;
      dist.set(w, dv + 1);
      queue.push(w);
    }
  }
  return dist.size - 1;
}

/**
 * The merged per-contact view. `contactId` must name a live contact
 * (soft-deleted/unknown → GraphError not_found); every other case degrades
 * honestly inside the payload.
 */
export async function getContactGraphPosition(
  conn: SqliteConn | PgConn,
  contactId: string,
  opts: GraphAnalysisOptions = {},
): Promise<ContactGraphPosition> {
  const ref = await getContactById(conn, contactId, opts.scope);
  if (!ref)
    throw new GraphError("not_found", `No contact with id "${contactId}".`);

  const resolved = resolveGraphAnalysisOptions(opts);
  const graph = await loadGraph(conn, opts);
  const neighborRows = await listEdges(
    conn,
    { contactId: ref.id, limit: 50 },
    opts.scope,
  );
  const neighbors: GraphNeighborRow[] = neighborRows.map((e) => ({
    edgeId: e.id,
    contactId: e.sourceId === ref.id ? e.targetId : e.sourceId,
    fullName: e.sourceId === ref.id ? e.targetName : e.sourceName,
    relation: e.relation,
    status: e.status,
    confidence: e.confidence,
    strength: e.strength,
    direction: e.bidirectional ? "both" : e.sourceId === ref.id ? "out" : "in",
    context: e.context,
    updatedAt: e.updatedAt,
  }));

  // Relationship facts straight off the live contact row — independent of
  // whether the contact participates in the analyzed graph. (Dialect-
  // narrowed tables, same house pattern as analysis.ts.)
  let row:
    | { relationshipScore: number | null; lastInteraction: string | null }
    | undefined;
  if (conn.dialect === "sqlite") {
    const t = conn.schema.contacts;
    [row] = await conn.db
      .select({
        relationshipScore: t.relationshipScore,
        lastInteraction: t.lastInteraction,
      })
      .from(t)
      .where(
        and(eq(t.id, ref.id), workspacePredicate(opts.scope, t.workspaceId)),
      )
      .limit(1);
  } else {
    const t = conn.schema.contacts;
    [row] = await conn.db
      .select({
        relationshipScore: t.relationshipScore,
        lastInteraction: t.lastInteraction,
      })
      .from(t)
      .where(
        and(eq(t.id, ref.id), workspacePredicate(opts.scope, t.workspaceId)),
      )
      .limit(1);
  }

  const base: ContactGraphPosition = {
    contact: {
      id: ref.id,
      fullName: ref.fullName,
      company: ref.company,
      role: ref.role,
      relationshipScore: row?.relationshipScore ?? null,
      lastInteraction: row?.lastInteraction ?? null,
    },
    analyzed: { nodes: graph.stats.nodes, edges: graph.stats.edges },
    degraded: null,
    inGraph: false,
    centrality: {
      degree: null,
      degreeRank: null,
      betweenness: null,
      betweennessNote: null,
    },
    community: null,
    reachableWithinDepth: 0,
    neighbors,
    warmIntros: [],
  };

  if (graph.stats.edges > resolved.limits.maxEdges) {
    return {
      ...base,
      degraded: `graph has ${graph.stats.edges} edges — centrality and community sections are capped at ${resolved.limits.maxEdges}; adjacency is always available`,
    };
  }

  const inGraph = graph.nodes.has(ref.id);
  if (!inGraph) {
    return {
      ...base,
      inGraph: false,
      centrality: {
        degree: 0,
        degreeRank: null,
        betweenness: 0,
        betweennessNote: "no confirmed edges include this contact",
      },
    };
  }

  const degree = degreeCentrality(graph);
  const rank = degree.findIndex((d) => d.contactId === ref.id);
  const { entries, skippedReason } = brandesBetweenness(graph, opts);
  const bEntry = entries?.find((b) => b.contactId === ref.id);

  const communities = louvain(graph).communities;
  const memberIndex = communities.findIndex((members) =>
    members.includes(ref.id),
  );
  const community =
    memberIndex === -1
      ? null
      : {
          communityId: memberIndex,
          label: communityLabel(graph, communities[memberIndex]!, memberIndex),
          size: communities[memberIndex]!.length,
        };

  const allIntros = warmIntrosOf(
    graph,
    resolved.maxDepth,
    GRAPH_ANALYSIS_LIMITS.listLimitCap,
  );
  const warmIntros = allIntros
    .filter(
      (w) =>
        w.contactId === ref.id || w.targetId === ref.id || w.viaId === ref.id,
    )
    .slice(0, resolved.limit);

  return {
    ...base,
    inGraph: true,
    centrality: {
      degree: rank === -1 ? 0 : degree[rank]!.degree,
      degreeRank: rank === -1 ? null : rank + 1,
      betweenness: bEntry ? Math.round(bEntry.normalized * 1000) / 1000 : null,
      betweennessNote:
        skippedReason ?? (bEntry ? null : "not computed for this contact"),
    },
    community,
    reachableWithinDepth: reachableWithin(
      graph.neighbors,
      ref.id,
      resolved.maxDepth,
    ),
    warmIntros,
  };
}
