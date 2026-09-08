// GET /api/card/views — v2.5 Phase 3: the owner-only viewer-analytics API.
//
//   GET ?days=30&limit=10&offset=0&includeBots=&includeOwnerViews=
//
// Returns the same `{ stats, recent, matches }` composition the dashboard
// strip, the settings analytics section and the CLI render from — one core
// function (`getViewsOverview`), so the surfaces can never disagree.
//
// Owner-only via the proxy boundary (every /api/* requires the owner
// session; only the two beacon paths under /api/card are public). Params are
// lenient — garbage falls back, out-of-range clamps — and the effective
// window is echoed in `stats.window`.
import { conn } from '@/lib/db';
import { getViewsOverview } from '@netpro/core/src/views';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';
import { viewsListParams } from '@/lib/views-request';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const overview = await getViewsOverview(conn, viewsListParams(sp));
    return crmJson(overview);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
