// packages/server/src/routes/index.ts
//
// Route table for the standalone server. Phase 1 ships health only;
// Phase 6 expands this to the full Web API contract by orchestrating
// @netpro/core (never reimplementing business logic here).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PgConn, SqliteConn } from '@netpro/db';
import { resolveAuthContext } from '../auth/index';
import type { EventBus } from '../events/index';
import type { JobRegistry } from '../jobs/index';
import { assignRequestId } from '../middleware/request-id';
import { sendJson } from '../middleware/json';
import { handleHealth } from './health';

export type RouteContext = {
  conn: SqliteConn | PgConn;
  jobs: JobRegistry;
  events: EventBus;
};

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

/**
 * Dispatch an incoming HTTP request.
 * Returns true when a handler ran; false when the path is unknown.
 */
export async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
): Promise<boolean> {
  assignRequestId(req, res);

  const method = (req.method ?? 'GET').toUpperCase();
  const path = pathnameOf(req);

  // CORS preflight for local UI development (Phase 9 will tighten origins).
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  if (method === 'GET' && (path === '/api/health' || path === '/health')) {
    const auth = resolveAuthContext({
      remoteAddress: req.socket.remoteAddress,
    });
    await handleHealth(req, res, { conn: ctx.conn, auth });
    return true;
  }

  if (method === 'GET' && path === '/') {
    sendJson(res, 200, {
      name: 'NetPro',
      service: '@netpro/server',
      message: 'Local-first NetPro HTTP server',
      health: '/api/health',
    });
    return true;
  }

  return false;
}
