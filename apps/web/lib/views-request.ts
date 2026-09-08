// apps/web/lib/views-request.ts
//
// Shared query-string parsing for the v2.5 Phase 3 viewer-analytics routes.
// The proxy is the ownership boundary (all /api/* require the owner
// session); these helpers cover what the boundary does not: a bounded views
// window and timeline page. Garbage falls back to defaults and out-of-range
// values clamp (the house pattern from the graph/skills parsers) — and the
// response echoes the effective window in `stats.window`, so a caller that
// asked for `days=365` can see it got 90 rather than guessing.
import { VIEWS_DEFAULT_DAYS, VIEWS_DEFAULT_LIMIT, VIEWS_MAX_DAYS, VIEWS_MAX_LIMIT } from '@netpro/core/src/views';

function boundedInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function flag(raw: string | null): boolean {
  return raw !== null && (raw.trim() === '1' || raw.trim().toLowerCase() === 'true');
}

export interface ViewsListParams {
  days: number;
  limit: number;
  offset: number;
  includeBots: boolean;
  includeOwnerViews: boolean;
}

/**
 * `?days=&limit=&offset=&includeBots=&includeOwnerViews=` for
 * `GET /api/card/views`. Days clamps to the 90-day retention window; limit
 * sizes the breakdowns, the timeline page and the match list together.
 */
export function viewsListParams(sp: URLSearchParams): ViewsListParams {
  return {
    days: boundedInt(sp.get('days'), VIEWS_DEFAULT_DAYS, 1, VIEWS_MAX_DAYS),
    limit: boundedInt(sp.get('limit'), VIEWS_DEFAULT_LIMIT, 1, VIEWS_MAX_LIMIT),
    offset: boundedInt(sp.get('offset'), 0, 0, 1_000_000),
    includeBots: flag(sp.get('includeBots')),
    includeOwnerViews: flag(sp.get('includeOwnerViews')),
  };
}
