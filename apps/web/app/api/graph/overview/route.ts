// GET /api/graph/overview?status=&relation=&minConfidence=&limit=&depth=
// v2.0 Phase 3 — the graph-native overview (communities, centrality,
// components, avg path length, warm-intro candidates) on its own endpoint,
// mirroring the dashboard strip. Owner-only via the proxy /api boundary.
import { conn } from '@/lib/db';
import { getNetworkGraph } from '@netpro/core/src/graph';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';
import { graphAnalysisParams } from '@/lib/graph-request';

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const graph = await getNetworkGraph(conn, graphAnalysisParams(p));
    return crmJson(graph);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
