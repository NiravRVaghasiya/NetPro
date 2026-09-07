// apps/web/lib/graph-request.ts
//
// Shared query-string parsing for the v2.0 Phase 3 graph routes. The proxy is
// the ownership boundary (all /api/* require the owner session); these helpers
// cover what the boundary does not: bounded, sane parameters for the graph
// engine — with the plan's tighter WEB depth cap (1–6; the engine itself
// allows 1–8 and the CLI exposes that full range).
import {
  EDGE_RELATIONS,
  PATHFINDER_LIMITS,
  type GraphAnalysisOptions,
} from '@netpro/core/src/graph';
import { CrmRequestError } from './crm-request';

const DEEP_LIMIT = PATHFINDER_LIMITS.apiMaxDepth;

function boundedInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def; // garbage falls back, like /api/analytics
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Graph analysis options from `?status=&relation=&minConfidence=&limit=&depth=`.
 * `depth` is normalized into `maxDepth` here (default 4, web cap 6), so
 * every graph surface reads exactly one hop budget.
 */
export function graphAnalysisParams(sp: URLSearchParams): GraphAnalysisOptions {
  const relation = sp.get('relation')?.trim();
  if (relation && !(EDGE_RELATIONS as readonly string[]).includes(relation)) {
    throw new CrmRequestError(400, `Unknown relation "${relation}". Expected one of: ${EDGE_RELATIONS.join(', ')}.`);
  }
  const status = sp.get('status')?.trim();
  if (status && status !== 'confirmed' && status !== 'pending' && status !== 'all') {
    throw new CrmRequestError(400, `Unknown status "${status}". Expected confirmed, pending, or all.`);
  }
  const minConfidence = sp.get('minConfidence');
  if (minConfidence !== null && minConfidence !== '') {
    const n = Number(minConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new CrmRequestError(400, 'minConfidence must be a number between 0 and 1.');
    }
  }
  return {
    status: (status as GraphAnalysisOptions['status']) ?? undefined,
    relation: relation ?? undefined,
    minConfidence: minConfidence !== null && minConfidence !== '' ? Number(minConfidence) : undefined,
    limit: boundedInt(sp.get('limit'), 10, 1, 50),
    maxDepth: boundedInt(sp.get('depth'), 4, 1, DEEP_LIMIT),
  };
}

export interface GraphPathsParams {
  target: string;
  from: string | undefined;
  k: number;
  graph: GraphAnalysisOptions;
}

/** Parse `GET /api/graph/paths` — target required; depth capped at 1–6. */
export function graphPathsParams(sp: URLSearchParams): GraphPathsParams {
  const target = sp.get('target')?.trim() ?? '';
  if (!target) {
    throw new CrmRequestError(400, 'A "target" contact selector (id, email, or exact name) is required.');
  }
  const graph = graphAnalysisParams(sp);
  const from = sp.get('from')?.trim() || undefined;
  if (from && from.length > 320) throw new CrmRequestError(400, 'The "from" selector is too long.');
  if (target.length > 320) throw new CrmRequestError(400, 'The "target" selector is too long.');
  return {
    target,
    from,
    k: boundedInt(sp.get('k'), PATHFINDER_LIMITS.defaultAlternatives, 1, PATHFINDER_LIMITS.maxAlternatives),
    graph,
  };
}
