// apps/web/lib/netpro-server.ts
//
// Phase 9 — Web UI foundation: the Web UI is a client of the local NetPro
// server, not its backend.
//
// The server exposes the stable Web API (GET /api/contacts, /api/search,
// /api/graph, /api/jobs, /api/events, ...) and the Web UI visualizes it.
// This module is the one place the UI needs to know the server's address and
// how to authenticate to it. Everything else — Observatory, Network, Search,
// People, Activity — is a visualization built on top of these helpers.
//
// Design rules (from the plan):
//   * packages/core is the business logic layer.
//   * packages/server is HTTP/API/jobs/SSE/auth/config.
//   * apps/web is visualization + control (no business logic duplication).
//   * SQLite is the default DB; the Web UI never touches it directly when
//     the server client is available.
//   * The server URL defaults to http://127.0.0.1:3777 (netpro serve).
//     Production / Docker can relocate it via NETPRO_SERVER_URL or
//     NEXT_PUBLIC_NETPRO_SERVER_URL — the latter is readable in the browser
//     for EventSource.
//
// When the server is unreachable (e.g. during `next dev` without `netpro
// serve`), callers should degrade gracefully: the Observatory shows a banner
// "Server not reachable at http://127.0.0.1:3777 — run `netpro serve`", but
// the UI still renders via its direct DB fallback where available. The new
// Observatory/Network/Activity pages are server-driven; the legacy
// Dashboard/Search/Contacts pages remain direct-DB until Phase 24 removes them.

/** The local NetPro server's origin. */
export function getServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.NETPRO_SERVER_URL?.trim() ||
    env.NEXT_PUBLIC_NETPRO_SERVER_URL?.trim() ||
    'http://127.0.0.1:3777';
  // Never double-slash when callers do `${url}/api/...`.
  return raw.replace(/\/$/, '');
}

/** Whether the server URL points at loopback (so no token is needed in local mode). */
export function isLoopbackServerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export type ServerFetchOptions = RequestInit & {
  /** Override the base URL (tests). */
  baseUrl?: string;
  /** Bearer token for `token` mode (when not loopback). */
  token?: string;
};

function authHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch a path from the NetPro server.
 *
 * Handles:
 *  - base URL resolution (NETPRO_SERVER_URL → 127.0.0.1:3777),
 *  - Authorization when a token is configured,
 *  - JSON parsing with a typed helper,
 *  - a `serverUrl` echo so callers can show "Connected to …".
 */
export async function serverFetch(
  path: string,
  options: ServerFetchOptions = {}
): Promise<Response> {
  const base = options.baseUrl ?? getServerUrl();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const token =
    options.token ??
    process.env.NETPRO_AUTH_TOKEN?.trim() ??
    process.env.NEXT_PUBLIC_NETPRO_AUTH_TOKEN?.trim() ??
    undefined;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
    ...authHeaders(token),
  };
  // Prefer JSON; the server's SSE endpoint overrides via Accept.
  if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, {
    ...options,
    headers,
  });
}

export async function serverFetchJson<T>(path: string, options: ServerFetchOptions = {}): Promise<{
  ok: boolean;
  status: number;
  data: T;
  serverUrl: string;
}> {
  const base = options.baseUrl ?? getServerUrl();
  const res = await serverFetch(path, options);
  const text = await res.text();
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = text as unknown as T;
  }
  return { ok: res.ok, status: res.status, data, serverUrl: base };
}

/** Convenience: GET /api/health */
export async function fetchServerHealth(opts: ServerFetchOptions = {}) {
  return serverFetchJson<{ status: string; dialect: string; latencyMs: number }>(
    '/api/health',
    opts
  );
}

/** Convenience: GET /api/server-info */
export async function fetchServerInfo(opts: ServerFetchOptions = {}) {
  return serverFetchJson<{
    name: string;
    service: string;
    authMode: string;
  }>('/api/server-info', opts);
}

/** Convenience: GET /api/analytics/overview */
export async function fetchAnalyticsOverview(opts: ServerFetchOptions = {}) {
  return serverFetchJson<unknown>('/api/analytics', opts);
}

/** Convenience: GET /api/graph */
export async function fetchGraph(opts: ServerFetchOptions = {}) {
  return serverFetchJson<unknown>('/api/graph', opts);
}

/** Convenience: GET /api/search?q=... */
export async function fetchSearch(
  query: string,
  extra: Record<string, string | undefined> = {},
  opts: ServerFetchOptions = {}
) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== '') params.set(k, v);
  }
  const qs = params.toString();
  return serverFetchJson<unknown>(`/api/search${qs ? `?${qs}` : ''}`, opts);
}

/** Convenience: GET /api/jobs */
export async function fetchJobs(
  filter: { type?: string; status?: string; limit?: string } = {},
  opts: ServerFetchOptions = {}
) {
  const params = new URLSearchParams();
  if (filter.type) params.set('type', filter.type);
  if (filter.status) params.set('status', filter.status);
  if (filter.limit) params.set('limit', filter.limit);
  const qs = params.toString();
  return serverFetchJson<{ jobs: unknown[]; total: number }>(`/api/jobs${qs ? `?${qs}` : ''}`, opts);
}

/** The SSE URL the browser should connect to (EventSource). */
export function getEventsUrl(
  extra: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = getServerUrl(env);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) {
    if (v) params.set(k, v);
  }
  const token =
    env.NETPRO_AUTH_TOKEN?.trim() || env.NEXT_PUBLIC_NETPRO_AUTH_TOKEN?.trim() || '';
  // EventSource cannot set headers, so the token must be a query param when not loopback.
  if (token && !isLoopbackServerUrl(base)) {
    params.set('token', token);
  }
  const qs = params.toString();
  return `${base}/api/events${qs ? `?${qs}` : ''}`;
}

/** Whether the UI should treat the server as the source of truth. */
export function isServerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  // When NEXT_PUBLIC_NETPRO_SERVER_URL is set we are definitely server-mode.
  // When running inside `netpro serve`'s embedded `@netpro/server`, the
  // server is always at 127.0.0.1:3777 and the legacy direct-DB path is still
  // valid — but the Observatory/Network/Activity pages should prefer the
  // server to demonstrate the Phase 9 foundation.
  if (env.NEXT_PUBLIC_NETPRO_SERVER_URL || env.NETPRO_SERVER_URL) return true;
  // Default local-first: try the server first, fall back to DB.
  return true;
}
