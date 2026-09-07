// GET /api/graph/paths?target=&from=&depth=&relation=&status=&minConfidence=&k=
// v2.0 Phase 3 — the warm-intro pathfinder API. Selectors resolve through the
// shared resolver (unknown target → 404, ambiguous → 400, per the plan's
// verification list); depth is capped at 1–6 here; responses carry the ranked
// k-shortest chains with per-node score/recency and the first-ask suggestion.
// Drafting stays where it lives today: the composer posts to /api/outreach.
import { conn } from '@/lib/db';
import { planIntroPaths } from '@netpro/core/src/graph';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';
import { graphPathsParams } from '@/lib/graph-request';

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const { target, from, k, graph } = graphPathsParams(p);
    const plan = await planIntroPaths(conn, { target, from, k }, graph);
    return crmJson(plan);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
