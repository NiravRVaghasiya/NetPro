// packages/server/src/routes/index.ts
//
// Route table for the standalone server. Phase 1 shipped health only;
// Phase 2 added the local console page at `/`; Phase 5 gates everything on the
// local-first auth policy. Phase 6 expands this to the full Web API contract
// by orchestrating @netpro/core (never reimplementing business logic here).
//
// Authentication model (see ../auth):
//   • `/api/health` and `/api/server-info` are public — a probe must work
//     before anyone holds a credential, and both are deliberately terse.
//   • Everything else needs the local operator: a direct loopback request
//     (mode `local`), a valid access token (modes `local`/`token`), or open
//     mode's explicit "something else authenticates callers".
//   • The console page at `/` is local-only: it names the database path.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describeConn, type PgConn, type SqliteConn } from '@netpro/db';
import {
  resolveAuthContext,
  type AuthContext,
  type AuthPolicy,
  type AuthRequestInfo,
} from '../auth/index';
import type { EventBus } from '../events/index';
import type { JobRegistry } from '../jobs/index';
import { assignRequestId } from '../middleware/request-id';
import { sendJson } from '../middleware/json';
import { handleHealth } from './health';
import { handleHome, handleLocked } from './home';

export type RouteContext = {
  conn: SqliteConn | PgConn;
  jobs: JobRegistry;
  events: EventBus;
  /** Phase 5 authentication policy for this process. */
  auth: AuthPolicy;
};

/**
 * Paths that answer without any credential.
 *
 * Keep this list short and deliberate: a readiness probe and the service
 * identity. Both return the same body to everyone.
 */
export const PUBLIC_API_PATHS: readonly string[] = ['/api/health', '/health', '/api/server-info'];

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.includes(path);
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function requestInfo(req: IncomingMessage): AuthRequestInfo {
  return {
    remoteAddress: req.socket.remoteAddress,
    headers: req.headers,
    url: req.url,
  };
}

/**
 * CORS for a local-first server.
 *
 * The Web UI on `http://localhost:3000` calling the API on
 * `http://127.0.0.1:3777` is a genuine cross-origin request, but it carries a
 * credential — the caller's session token or the access token — so the origin
 * is echoed only when the request authenticated. An unauthenticated request
 * gets no CORS grant at all, which keeps a random page in the user's browser
 * from reading API responses off the local port.
 */
function applyCors(req: IncomingMessage, res: ServerResponse, authenticated: boolean): void {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!authenticated || typeof origin !== 'string' || origin.trim() === '') return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-NetPro-Token, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function unauthorized(res: ServerResponse, auth: AuthContext, policy: AuthPolicy): void {
  const hint =
    policy.mode === 'local'
      ? 'Local requests are trusted. From another machine, send the local access token as ' +
        '`Authorization: Bearer <token>` (see `netpro token`).'
      : policy.mode === 'token'
        ? 'Send the local access token as `Authorization: Bearer <token>` (see `netpro token`).'
        : 'Authentication is open; the request was rejected for another reason.';
  sendJson(
    res,
    401,
    {
      error: 'Unauthorized',
      reason: auth.reason ?? 'missing-credentials',
      authMode: policy.mode,
      hint,
    },
    policy.token ? { 'WWW-Authenticate': 'Bearer realm="netpro"' } : {}
  );
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
  const auth = resolveAuthContext(requestInfo(req), ctx.auth);

  applyCors(req, res, auth.authenticated);

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store, max-age=0' });
    res.end();
    return true;
  }

  if (method === 'GET' && (path === '/api/health' || path === '/health')) {
    await handleHealth(req, res, { conn: ctx.conn, auth });
    return true;
  }

  if (method === 'GET' && path === '/api/server-info') {
    sendJson(res, 200, {
      name: 'NetPro',
      service: '@netpro/server',
      message: 'Local-first NetPro HTTP server',
      health: '/api/health',
      authMode: ctx.auth.mode,
      authenticationRequired: !auth.authenticated,
    });
    return true;
  }

  if (method === 'GET' && path === '/api/identity') {
    // The local installation identity (Phase 5). Operator-only: it names the
    // install, and it is what the Web UI shows instead of a user profile.
    if (!auth.authenticated) {
      unauthorized(res, auth, ctx.auth);
      return true;
    }
    const identity = ctx.auth.installation;
    sendJson(res, 200, {
      authenticated: true,
      kind: auth.kind,
      authMode: ctx.auth.mode,
      tokenConfigured: ctx.auth.token !== null,
      installation: identity
        ? {
            id: identity.id,
            createdAt: identity.createdAt || null,
            owner: identity.owner ?? null,
          }
        : null,
      // Never the token itself — only whether remote access has a credential.
    });
    return true;
  }

  if (!auth.authenticated && (path.startsWith('/api') || path.startsWith('/api/'))) {
    // Fail closed for every future route as well as today's: an API path is
    // private unless it is in PUBLIC_API_PATHS.
    if (!isPublicApiPath(path)) {
      unauthorized(res, auth, ctx.auth);
      return true;
    }
  }

  if (method === 'GET' && path === '/') {
    if (!auth.authenticated) {
      handleLocked(res, { authMode: ctx.auth.mode, reason: auth.reason });
      return true;
    }
    // The local console: identity + live health, linked to /api/health.
    handleHome(res, {
      dialect: ctx.conn.dialect,
      database: describeConn(ctx.conn),
      installation: ctx.auth.installation,
      authMode: ctx.auth.mode,
    });
    return true;
  }

  return false;
}
