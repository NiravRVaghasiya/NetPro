// packages/server/src/routes/graph.ts
//
// Graph routes — orchestrate @netpro/core/graph, never reimplement it.
//
// GET /api/graph              → getNetworkGraph (overview)
// GET /api/graph/overview     → same (alias for web compatibility)
// GET /api/graph/network      → same
// GET /api/graph/path         → planIntroPaths (single target+from)
// GET /api/graph/paths        → same (plural alias)
// GET /api/graph/position/:id → per-contact position (optional)
//
// Phase 8: graph operations emit `graph.updated` (overview) and
// `relationship.discovered` / `graph.updated` for path results so the
// Activity feed can answer "what did NetPro discover?".

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getNetworkGraph, planIntroPaths, getNetworkVisualization, PATHFINDER_LIMITS } from '@netpro/core/src/graph';
import { GraphError } from '@netpro/core/src/graph';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';
import type { EventBus } from '../events/index';

export type GraphDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  events?: EventBus;
};

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function errorStatus(err: unknown): number {
  if (err instanceof GraphError) {
    return err.code === 'not_found' ? 404 : err.code === 'invalid_input' ? 400 : 409;
  }
  return 500;
}

function graphAnalysisParams(p: URLSearchParams) {
  const limit = num(p.get('limit'));
  const depth = num(p.get('depth')) ?? num(p.get('maxDepth'));
  const minConfidence = p.get('minConfidence') !== null ? num(p.get('minConfidence')) : undefined;
  const relation = p.get('relation')?.trim() || undefined;
  const status = p.get('status')?.trim() || undefined;
  const params: Record<string, unknown> = {};
  if (limit !== undefined) params.limit = limit;
  if (depth !== undefined) params.maxDepth = depth;
  if (minConfidence !== undefined) params.minConfidence = minConfidence;
  if (relation) params.relation = relation;
  if (status) params.status = status;
  return params;
}

export async function handleGraphOverview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GraphDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  try {
    const graph = await getNetworkGraph(deps.conn, {
      ...graphAnalysisParams(p),
    } as never);
    // Phase 8 — the graph is the visual centerpiece (Phase 11). Every overview
    // fetch is a chance to tell the UI the shape just observed, so the
    // Observatory can stay fresh without polling.
    deps.events?.publish({
      type: 'graph.updated',
      message: `Graph: ${graph.nodes} nodes, ${graph.edges} edges`,
      nodes: (graph as { nodes?: number }).nodes,
      edges: (graph as { edges?: number }).edges,
      components: (graph as { components?: unknown }).components,
    });
    sendJson(res, 200, graph);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

export async function handleGraphPaths(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GraphDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const target = p.get('target')?.trim() || p.get('to')?.trim() || '';
  const from = p.get('from')?.trim() || undefined;
  // Phase 13 — `depth` (BFS hop budget) and `k` (ranked alternatives) are
  // independent knobs; an earlier revision read `k` as the depth fallback,
  // so `?k=3` silently tripled the hop budget. `limit` sizes list sections,
  // never alternatives.
  const depthRaw = num(p.get('depth')) ?? num(p.get('maxDepth')) ?? num(p.get('max-depth'));
  const kRaw = num(p.get('k')) ?? num(p.get('alt')) ?? num(p.get('alternatives'));
  if (!target) {
    sendJson(res, 400, { error: 'A target contact is required (name, email, or id).', code: 'invalid_input' });
    return;
  }
  if (depthRaw !== undefined && (!Number.isFinite(depthRaw) || depthRaw < 1)) {
    sendJson(res, 400, { error: `Invalid depth "${p.get('depth') ?? p.get('maxDepth')}". Expected a positive number of hops.`, code: 'invalid_input' });
    return;
  }
  if (kRaw !== undefined && (!Number.isFinite(kRaw) || kRaw < 1)) {
    sendJson(res, 400, { error: `Invalid alternatives "${p.get('k') ?? p.get('alt')}". Expected a positive number.`, code: 'invalid_input' });
    return;
  }
  try {
    const analysis: Record<string, unknown> = { ...graphAnalysisParams(p) };
    // The web API caps depth tighter than the engine's hard cap (8) — the
    // documented PATHFINDER_LIMITS.apiMaxDepth — and clamps alternatives to
    // the ranked-list budget rather than failing hand-typed URLs.
    if (depthRaw !== undefined) {
      analysis.maxDepth = Math.min(Math.trunc(depthRaw), PATHFINDER_LIMITS.apiMaxDepth);
    }
    const k = Math.min(
      Math.max(Math.trunc(kRaw ?? PATHFINDER_LIMITS.defaultAlternatives), 1),
      PATHFINDER_LIMITS.maxAlternatives,
    );
    // planIntroPaths third arg is GraphAnalysisOptions
    const plan = await planIntroPaths(
      deps.conn,
      { target, from, k },
      analysis as never
    );
    // Phase 8 — a discovered path is a relationship chain. Surface it as
    // both a graph update and a relationship discovery so the Activity feed
    // can show "New path found" without parsing the full graph payload.
    if ((plan as { found?: boolean }).found) {
      deps.events?.publish({
        type: 'relationship.discovered',
        message: `Path to ${target}: ${(plan as { paths?: unknown[] }).paths?.length ?? 0} route(s) found`,
        target,
        from,
        paths: (plan as { paths?: unknown }).paths,
      });
      deps.events?.publish({
        type: 'graph.updated',
        message: `Pathfinder: path to ${target}`,
        target,
        from,
      });
    }
    sendJson(res, 200, plan);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

export async function handleGraphVisualization(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GraphDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  try {
    const viz = await getNetworkVisualization(deps.conn, {
      ...graphAnalysisParams(p),
      visualizationLimit: num(p.get('visualizationLimit')) ?? num(p.get('limitNodes')) ?? num(p.get('maxNodes')),
    } as never);
    deps.events?.publish({
      type: 'graph.updated',
      message: `Graph visualization: ${viz.meta.shownNodes} nodes, ${viz.meta.shownEdges} edges`,
      shownNodes: viz.meta.shownNodes,
      shownEdges: viz.meta.shownEdges,
      communities: viz.meta.communities,
    });
    sendJson(res, 200, viz);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

// Aliases for plan compat: /api/graph and /api/graph/path both work.
export { handleGraphOverview as handleGraph, handleGraphPaths as handleGraphPath };
