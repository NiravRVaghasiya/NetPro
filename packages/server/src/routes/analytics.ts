// packages/server/src/routes/analytics.ts
//
// GET /api/analytics
// GET /api/analytics/network
// GET /api/analytics/overview
//
// Orchestrates @netpro/core/analytics — the single shared entry point for
// `netpro analyze` and the dashboard. Every query param mirrors the CLI flags.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getNetworkOverview } from '@netpro/core/src/analytics';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type AnalyticsDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export async function handleAnalytics(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const graph = p.get('graph');
  const views = p.get('views');
  const content = p.get('content');
  try {
    const overview = await getNetworkOverview(deps.conn, {
      dormantDays: num(p.get('days')) ?? num(p.get('dormantDays')),
      activeDays: num(p.get('activeDays')),
      growthMonths: num(p.get('months')) ?? num(p.get('growthMonths')),
      limit: num(p.get('limit')),
      includeGraph: graph === null ? true : graph !== '0',
      includeViews: views === null ? true : views !== '0',
      includeContent: content === null ? true : content !== '0',
    });
    sendJson(res, 200, overview);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    const status = code === 'invalid_input' ? 400 : code === 'not_found' ? 404 : 500;
    sendJson(res, status, { error: msg, code });
  }
}

// /api/analytics/network is an alias — same payload.
export const handleAnalyticsNetwork = handleAnalytics;
