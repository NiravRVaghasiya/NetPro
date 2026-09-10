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

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getNetworkGraph, planIntroPaths } from '@netpro/core/src/graph';
import { GraphError } from '@netpro/core/src/graph';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type GraphDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
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
  const depth = num(p.get('depth')) ?? num(p.get('k')) ?? num(p.get('maxDepth'));
  const k = num(p.get('k')) ?? num(p.get('limit'));
  if (!target) {
    sendJson(res, 400, { error: 'A target contact is required (name, email, or id).', code: 'invalid_input' });
    return;
  }
  try {
    const analysis: Record<string, unknown> = { ...graphAnalysisParams(p) };
    if (depth !== undefined) analysis.maxDepth = depth;
    // planIntroPaths third arg is GraphAnalysisOptions
    const plan = await planIntroPaths(
      deps.conn,
      { target, from, k: k ?? 1 },
      analysis as never
    );
    sendJson(res, 200, plan);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

// Aliases for plan compat: /api/graph and /api/graph/path both work.
export { handleGraphOverview as handleGraph, handleGraphPaths as handleGraphPath };
