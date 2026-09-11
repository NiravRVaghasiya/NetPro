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
//     mode's explicit \"something else authenticates callers\".
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
import { applySecurityHeaders, isOriginAllowed } from '../middleware/security';
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitKey,
  type RateLimiter,
} from '../middleware/rate-limit';
import { handleHealth } from './health';
import { handleHome, handleLocked } from './home';
import { handleListContacts, handleGetContact } from './contacts';
import { handleSearch } from './search';
import { handleGraphOverview, handleGraphPaths, handleGraphVisualization } from './graph';
import { handleProviders } from './providers';
import { handleAnalytics } from './analytics';
import { handleImportPost, handleImportPreviewPost, handleImportGet } from './import';
import { handleEnrichPost, handleEnrichGet } from './enrich';
import { handleListJobs, handleGetJob, handleCreateJob, handleCancelJob } from './jobs';
import { handleEvents } from './events';
import { handleGetSettings, handlePutSettings } from './settings';
import { handleScanPost } from './scan';
import {
  handleGetCalendarEvent,
  handleListCalendarEvents,
} from './calendar-events';

export type RouteContext = {
  conn: SqliteConn | PgConn;
  jobs: JobRegistry;
  events: EventBus;
  /** Phase 5 authentication policy for this process. */
  auth: AuthPolicy;
  /** App config for settings route. */
  config?: { host: string; port: number; autoMigrate: boolean; auth: { mode: string } };
  /**
   * Phase 23 — per-IP rate limiter. `createApp` always provides one; direct
   * dispatch callers fall back to a shared default limiter (still limited).
   */
  rateLimit?: RateLimiter;
  /**
   * Phase 23 — origin allow-list (`null` = loopback-only default) and the
   * HSTS switch. `createApp` resolves both from the server config.
   */
  security?: { allowedOrigins: string[] | null; hsts: boolean };
};

/** Fallback limiter for direct dispatch callers; `createApp` builds a per-app one. */
const sharedRateLimiter = createRateLimiter({
  enabled: true,
  max: DEFAULT_RATE_LIMIT_MAX,
  windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
});

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
 * is granted only when the request authenticated. An unauthenticated request
 * gets no CORS grant at all, which keeps a random page in the user's browser
 * from reading API responses off the local port.
 *
 * Phase 23 — authentication alone is no longer enough: the origin must also
 * be allowed (loopback by default, or a member of the explicit
 * `NETPRO_ALLOWED_ORIGINS` / `allowed_origins` list). A bearer token in the
 * wrong browser tab must not become a cross-origin API grant.
 */
function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  authenticated: boolean,
  allowedOrigins: string[] | null
): void {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!authenticated || typeof origin !== 'string' || origin.trim() === '') return;
  if (!isOriginAllowed(origin, allowedOrigins)) return;
  res.setHeader('Access-Control-Allow-Origin', origin.trim());
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
  // Phase 23 — hardening headers on every response (probes, errors, and the
  // 404 below all flow through here). HSTS stays opt-in: it is only true
  // behind a TLS-terminating proxy.
  applySecurityHeaders(res, { hsts: ctx.security?.hsts ?? false });

  const method = (req.method ?? 'GET').toUpperCase();
  const path = pathnameOf(req);
  const auth = resolveAuthContext(requestInfo(req), ctx.auth);

  applyCors(req, res, auth.authenticated, ctx.security?.allowedOrigins ?? null);

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store, max-age=0' });
    res.end();
    return true;
  }

  // Phase 23 — per-IP rate limit. Cheap and unconditional (it runs before
  // auth so token-guessing collapses into 429s), except for the readiness
  // probes: an orchestrator must never read a limit as an outage. OPTIONS
  // preflights are exempt too — they do no work and must not consume budget.
  if (!(method === 'GET' && isPublicApiPath(path))) {
    const limiter = ctx.rateLimit ?? sharedRateLimiter;
    const decision = limiter.check(rateLimitKey(req.socket.remoteAddress));
    if (!decision.allowed) {
      sendJson(
        res,
        429,
        {
          error: 'Too many requests',
          code: 'rate_limited',
          retryAfterMs: decision.retryAfterMs,
        },
        { 'Retry-After': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) }
      );
      return true;
    }
  }

  // ── Public probes ──────────────────────────────────────────────────
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
    });
    return true;
  }

  // Guard the API: private unless public.
  if (!auth.authenticated && path.startsWith('/api')) {
    if (!isPublicApiPath(path)) {
      unauthorized(res, auth, ctx.auth);
      return true;
    }
  }

  // ── Home console (local-only) ─────────────────────────────────────
  if (method === 'GET' && path === '/') {
    if (!auth.authenticated) {
      handleLocked(res, { authMode: ctx.auth.mode, reason: auth.reason });
      return true;
    }
    handleHome(res, {
      dialect: ctx.conn.dialect,
      database: describeConn(ctx.conn),
      installation: ctx.auth.installation,
      authMode: ctx.auth.mode,
    });
    return true;
  }

  // ── Phase 6 Web API ────────────────────────────────────────────────
  // Contacts
  if (path === '/api/contacts' && method === 'GET') {
    await handleListContacts(req, res, { conn: ctx.conn, auth });
    return true;
  }
  if (path.startsWith('/api/contacts/') && method === 'GET') {
    const id = path.slice('/api/contacts/'.length).split('/')[0] ?? '';
    // Exclude the list path — /api/contacts/ itself is not a detail.
    if (id) {
      await handleGetContact(req, res, { conn: ctx.conn, auth }, decodeURIComponent(id));
      return true;
    }
  }

  // Search — Phase 8: emits search.started / completed into the SSE bus
  if ((path === '/api/search' || path === '/api/contacts/search') && method === 'GET') {
    await handleSearch(req, res, { conn: ctx.conn, auth, events: ctx.events });
    return true;
  }

  // Graph — overview variants — Phase 8: emits graph.updated / relationship.discovered
  if (
    (path === '/api/graph' ||
      path === '/api/graph/overview' ||
      path === '/api/graph/network') &&
    method === 'GET'
  ) {
    await handleGraphOverview(req, res, { conn: ctx.conn, auth, events: ctx.events });
    return true;
  }
  // Graph — pathfinder
  if (
    (path === '/api/graph/path' || path === '/api/graph/paths') &&
    method === 'GET'
  ) {
    await handleGraphPaths(req, res, { conn: ctx.conn, auth, events: ctx.events });
    return true;
  }
  // Graph — interactive visualization (Phase 11)
  if (
    (path === '/api/graph/visualization' ||
      path === '/api/graph/data' ||
      path === '/api/graph/viz') &&
    method === 'GET'
  ) {
    await handleGraphVisualization(req, res, { conn: ctx.conn, auth, events: ctx.events });
    return true;
  }
  // Alias: /api/graph/path and /api/graph/paths via query style already
  // covered; also support /api/graph/path?target=&from= as specified in Phase 6.

  // Analytics
  if (
    (path === '/api/analytics' ||
      path === '/api/analytics/network' ||
      path === '/api/analytics/overview') &&
    method === 'GET'
  ) {
    await handleAnalytics(req, res, { conn: ctx.conn, auth });
    return true;
  }

  // Import
  if (path === '/api/import' && method === 'POST') {
    await handleImportPost(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  // Import preview/validate (Phase 15) — must be matched before the
  // `/api/import/:id` GET below.
  if (path === '/api/import/preview' && method === 'POST') {
    await handleImportPreviewPost(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  if (path.startsWith('/api/import/') && method === 'GET') {
    await handleImportGet(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }

  // Scan
  if (path === '/api/scan' && method === 'POST') {
    await handleScanPost(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }

  // Enrich — Phase 8: observable job with enrichment.* events
  if (path === '/api/enrich' && method === 'POST') {
    await handleEnrichPost(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  if (path.startsWith('/api/enrich/') && method === 'GET') {
    await handleEnrichGet(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  // Scan status aliases (job-based)
  if (path.startsWith('/api/scan/') && method === 'GET') {
    const id = path.slice('/api/scan/'.length).split('/')[0] ?? '';
    if (id) {
      const job = ctx.jobs.get(id);
      if (!job || job.type !== 'scan') {
        sendJson(res, 404, { error: `No scan job with id "${id}".`, code: 'not_found' });
        return true;
      }
      sendJson(res, 200, { job });
      return true;
    }
  }

  // Jobs
  if (path === '/api/jobs' && method === 'GET') {
    await handleListJobs(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  if (path === '/api/jobs' && method === 'POST') {
    await handleCreateJob(req, res, {
      conn: ctx.conn,
      auth,
      jobs: ctx.jobs,
      events: ctx.events,
    });
    return true;
  }
  // /api/jobs/:id/cancel must be matched before /api/jobs/:id
  if (path.startsWith('/api/jobs/') && path.endsWith('/cancel') && method === 'POST') {
    const id = path.slice('/api/jobs/'.length, -'/cancel'.length).replace(/\/$/, '');
    await handleCancelJob(req, res, { conn: ctx.conn, auth, jobs: ctx.jobs, events: ctx.events }, decodeURIComponent(id));
    return true;
  }
  if (path.startsWith('/api/jobs/') && method === 'GET') {
    const id = path.slice('/api/jobs/'.length).split('/')[0] ?? '';
    if (id) {
      await handleGetJob(req, res, { conn: ctx.conn, auth, jobs: ctx.jobs, events: ctx.events }, decodeURIComponent(id));
      return true;
    }
  }
  if (path.startsWith('/api/jobs/') && method === 'POST') {
    // POST /api/jobs/:id/cancel already handled; POST /api/jobs/:id as cancel alias
    const rest = path.slice('/api/jobs/'.length);
    if (rest && !rest.includes('/')) {
      // Treat POST /api/jobs/:id with body { action: 'cancel' } as cancel.
      // Consume the body and proxy to cancel if requested — otherwise 405.
      // Read body lazily; we implement a small check.
      try {
        const { readJsonBody } = await import('../middleware/json');
        const body = await readJsonBody(req).catch(() => null);
        const action = (body as { action?: string } | null)?.action;
        if (action === 'cancel') {
          await handleCancelJob(req, res, { conn: ctx.conn, auth, jobs: ctx.jobs, events: ctx.events }, decodeURIComponent(rest));
          return true;
        }
      } catch {
        // fallthrough to 405
      }
      sendJson(res, 405, { error: 'Method not allowed. Use POST /api/jobs/:id/cancel.' });
      return true;
    }
  }

  // Events — dual meaning:
  //   * Accept: text/event-stream  → SSE stream (Phase 8)
  //   * otherwise                 → calendar events (GET /api/events JSON)
  if (path === '/api/events' && method === 'GET') {
    const accept = (req.headers.accept ?? '').toString();
    if (accept.includes('text/event-stream')) {
      handleEvents(req, res, { events: ctx.events });
      return true;
    }
    await handleListCalendarEvents(req, res, { conn: ctx.conn, auth });
    return true;
  }
  // SSE explicit alias — always a stream regardless of Accept.
  if (path === '/api/events/stream' && method === 'GET') {
    handleEvents(req, res, { events: ctx.events });
    return true;
  }
  // Phase 8 — CLI→server bridge: forward job.* from a terminal `netpro` run into the same SSE stream.
  if (path === '/api/events/ingest' && method === 'POST') {
    const { handleEventsIngest } = await import('./events');
    await handleEventsIngest(req, res, { events: ctx.events });
    return true;
  }
  if (path.startsWith('/api/events/') && method === 'GET') {
    const id = path.slice('/api/events/'.length).split('/')[0] ?? '';
    if (id && id !== 'stream') {
      // Calendar event detail — not the SSE endpoint.
      await handleGetCalendarEvent(req, res, { conn: ctx.conn, auth }, decodeURIComponent(id));
      return true;
    }
  }

  // Settings
  if (path === '/api/settings' && method === 'GET') {
    await handleGetSettings(req, res, {
      conn: ctx.conn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: (ctx.config ?? { host: '127.0.0.1', port: 3777, autoMigrate: true, auth: { mode: ctx.auth.mode } }) as any,
      auth: ctx.auth,
    });
    return true;
  }
  if ((path === '/api/settings' || path === '/api/config') && (method === 'PUT' || method === 'PATCH')) {
    await handlePutSettings(req, res, {
      conn: ctx.conn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: (ctx.config ?? { host: '127.0.0.1', port: 3777, autoMigrate: true, auth: { mode: ctx.auth.mode } }) as any,
      auth: ctx.auth,
    });
    return true;
  }
  // Alias: GET /api/config for CLI compat
  if (path === '/api/config' && method === 'GET') {
    await handleGetSettings(req, res, {
      conn: ctx.conn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: (ctx.config ?? { host: '127.0.0.1', port: 3777, autoMigrate: true, auth: { mode: ctx.auth.mode } }) as any,
      auth: ctx.auth,
    });
    return true;
  }

  // Providers — Phase 10/17 observatory strips
  if (
    (path === '/api/providers' || path === '/api/providers/status') &&
    method === 'GET'
  ) {
    await handleProviders(req, res, { conn: ctx.conn, auth });
    return true;
  }

  // ── Fallback: API 404 so the web UI gets JSON, not HTML ──────────
  if (path.startsWith('/api')) {
    sendJson(res, 404, { error: `Not found: ${method} ${path}` });
    return true;
  }

  return false;
}
