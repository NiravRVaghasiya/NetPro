// packages/server/src/auth/index.ts
//
// Phase 5 — authentication redesigned around a *local installation identity*
// instead of GitHub OAuth.
//
// The model:
//
//   • `local` (default) — requests that arrive over loopback are the local
//     operator. There is nothing to log into: the process and the person are
//     on the same machine. Requests that arrive any other way need the local
//     access token (`~/.netpro/keys/access-token`, `NETPRO_AUTH_TOKEN`), which
//     is why exposing the server cannot silently expose the data.
//
//   • `token` — every request needs the token, including loopback. For shared
//     machines, reverse proxies, and "I want to be explicit" setups.
//
//   • `open` — no authentication at all. Only correct when something *else*
//     authenticates the caller (a reverse proxy with its own auth, a VPN, an
//     isolated network). `netpro serve` says so, loudly, on every start.
//
// What this replaces: GitHub OAuth as the application's identity system. The
// server never needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
// NETPRO_OWNER_GITHUB_ID, NEXTAUTH_SECRET, or NEXTAUTH_URL to run. Phase 24
// removed the Web UI's Auth.js sign-in entirely, so there is no GitHub
// integration left anywhere: `local` / `token` / `open` are the only modes.
//
// This module performs no domain work: it answers "who is calling?" and
// nothing else. Authorization decisions stay with the routes.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  AUTH_MODES,
  DEFAULT_AUTH_MODE,
  readInstallationIdentity,
  resolveAccessToken,
  resolveAuthMode,
  type AuthMode,
  type InstallationIdentity,
} from '@netpro/db';

// Auth *policy* resolution lives in `@netpro/db` (it is a property of the
// installation — the CLI reports the same answer); this module owns the
// request-time decision. Re-exported so `@netpro/server` keeps one import
// surface for callers.
export { AUTH_MODES, DEFAULT_AUTH_MODE, resolveAuthMode, type AuthMode };

/** Everything the request path needs to make an authentication decision. */
export type AuthPolicy = {
  mode: AuthMode;
  /**
   * Bearer token accepted for non-loopback callers. `null` means the install
   * has no token yet — loopback still works, remote access is denied.
   */
  token: string | null;
  /** The local installation identity (Phase 5). */
  installation: InstallationIdentity | null;
};

/**
 * Resolve the policy for this process: mode, token, and installation identity.
 *
 * `mode` may be passed in when the caller already resolved it (the server's
 * `loadConfig` does, so config.toml is read once for both host and auth).
 */
export function loadAuthPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode?: AuthMode
): AuthPolicy {
  return {
    mode: mode ?? resolveAuthMode(env),
    token: resolveAccessToken(env),
    installation: readInstallationIdentity(env),
  };
}

export type AuthKind = 'loopback' | 'token' | 'open' | 'anonymous';

export type AuthContext = {
  mode: AuthMode;
  /** True when the caller may act (loopback in `local`, a valid token, or `open`). */
  authenticated: boolean;
  /**
   * True when the caller acts as the owner of this installation — the local
   * UI/CLI on loopback, or a holder of the local access token. `open` mode is
   * authenticated but NOT trusted: no credential was presented, so the request
   * does not get the richer diagnostics that name the installation.
   */
  trustedLocal: boolean;
  kind: AuthKind;
  installationId: string | null;
  /** Why an anonymous request was denied. */
  reason?: 'missing-credentials' | 'invalid-credentials';
};

/** Request facts the auth decision is derived from. */
export type AuthRequestInfo = {
  /** Peer address from the socket (`req.socket.remoteAddress`). */
  remoteAddress?: string | null;
  /** Node `req.headers`, or any case-insensitive header bag. */
  headers?: HeaderBag;
  /** Request URL (`req.url`), so `?token=` works for EventSource clients. */
  url?: string | null;
};

type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

function readHeader(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(n: string): string | null | undefined }).get(name);
    return value === undefined || value === null ? null : String(value);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (direct === undefined) return null;
  const value = Array.isArray(direct) ? direct[0] : direct;
  return value === undefined ? null : value;
}

/**
 * Is this socket peer on the loopback interface?
 *
 * Accepts IPv4 (`127.0.0.0/8`), IPv6 (`::1`), IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`), and Node's hex form (`::ffff:7f00:1`).
 */
export function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::1' || value.startsWith('127.')) return true;
  if (value === '::ffff:127.0.0.1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mapped) {
    // ::ffff:7f00:0/104 covers the mapped 127.0.0.0/8 range.
    return parseInt(mapped[1] ?? '0', 16) === 0x7f00;
  }
  return false;
}

/**
 * Headers that prove a request was forwarded by a proxy.
 *
 * A reverse proxy on the same machine connects from 127.0.0.1, so the socket
 * address alone would mark every proxied request as local. If any of these is
 * present the request did not come straight from this machine, and loopback
 * trust does not apply — the deployment uses a token (or `open` mode behind
 * whatever authenticates the proxy).
 *
 * Deliberately conservative: a client can *set* `X-Forwarded-For: 127.0.0.1`
 * itself, and a proxy may append rather than replace, so presence is enough to
 * withhold trust. Nobody is locked out by this: the token always works.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'] as const;

export function isDirectLoopbackRequest(info: AuthRequestInfo): boolean {
  if (!isLoopbackAddress(info.remoteAddress)) return false;
  for (const header of PROXY_HEADERS) {
    if (readHeader(info.headers, header)) return false;
  }
  return true;
}

/** Extract a presented credential: bearer header, NetPro header, or query. */
export function extractCredential(info: AuthRequestInfo): string | null {
  const authorization = readHeader(info.headers, 'authorization')?.trim();
  if (authorization) {
    const match = /^bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  const explicit = readHeader(info.headers, 'x-netpro-token')?.trim();
  if (explicit) return explicit;
  // `?token=` exists for browser EventSource, which cannot set headers. It is
  // accepted because the token is a bearer credential either way — but only
  // for authenticated routes, and it is never logged.
  const url = info.url;
  if (url) {
    try {
      const parsed = new URL(url, 'http://127.0.0.1');
      const fromQuery = parsed.searchParams.get('token')?.trim();
      if (fromQuery) return fromQuery;
    } catch {
      // Unparseable URL: no credential from that source.
    }
  }
  return null;
}

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first so the comparison is fixed-length (the raw
 * token length is not leaked by timing) and `timingSafeEqual` cannot throw on
 * mismatched buffer sizes.
 */
export function tokensEqual(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Decide who is calling.
 *
 * Pure: no IO, no globals. Loops, proxies, and tests all exercise this same
 * function.
 */
export function resolveAuthContext(
  info: AuthRequestInfo = {},
  policy: AuthPolicy = loadAuthPolicy()
): AuthContext {
  const installationId = policy.installation?.id ?? null;

  if (policy.mode === 'open') {
    return {
      mode: 'open',
      authenticated: true,
      trustedLocal: false,
      kind: 'open',
      installationId,
    };
  }

  if (policy.mode === 'local' && isDirectLoopbackRequest(info)) {
    return {
      mode: 'local',
      authenticated: true,
      trustedLocal: true,
      kind: 'loopback',
      installationId,
    };
  }

  const presented = extractCredential(info);
  if (policy.token !== null && tokensEqual(presented, policy.token)) {
    return {
      mode: policy.mode,
      authenticated: true,
      trustedLocal: true,
      kind: 'token',
      installationId,
    };
  }

  return {
    mode: policy.mode,
    authenticated: false,
    trustedLocal: false,
    kind: 'anonymous',
    installationId,
    reason: presented ? 'invalid-credentials' : 'missing-credentials',
  };
}

/**
 * Human-readable one-liner for the `netpro serve` banner and `netpro status`.
 */
export function describeAuthPolicy(policy: AuthPolicy): string {
  if (policy.mode === 'open') {
    return 'open — no authentication (rely on your network/reverse proxy)';
  }
  const tokenState = policy.token
    ? 'access token set for remote callers'
    : 'no access token yet — loopback only';
  return policy.mode === 'token'
    ? `token required for every request; ${tokenState}`
    : `local — loopback trusted; ${tokenState}`;
}

/**
 * Startup problems that must stop the server, and warnings that must be
 * visible. `netpro serve` prints warnings and refuses to start on errors.
 */
export function authStartupDiagnostics(
  policy: AuthPolicy,
  options: { host: string; isLoopbackHost: boolean }
): Array<{ level: 'error' | 'warning'; message: string }> {
  const diagnostics: Array<{ level: 'error' | 'warning'; message: string }> = [];

  if (policy.mode === 'token' && !policy.token) {
    diagnostics.push({
      level: 'error',
      message:
        'Auth mode "token" requires an access token, and none exists. ' +
        'Create one with `netpro token --rotate` (or set NETPRO_AUTH_TOKEN), then start the server again.',
    });
  }

  if (policy.mode === 'open' && !options.isLoopbackHost) {
    diagnostics.push({
      level: 'warning',
      message:
        `Binding ${options.host} with auth mode "open": NetPro answers anyone who can ` +
        'reach it. Only do this behind a reverse proxy, VPN, or firewall that ' +
        'authenticates callers.',
    });
  }

  if (policy.mode === 'local' && !options.isLoopbackHost && !policy.token) {
    diagnostics.push({
      level: 'warning',
      message:
        `Binding ${options.host} makes NetPro reachable from your network, but no access ` +
        'token exists yet — remote requests will get 401 until you create one ' +
        '(`netpro token --rotate`).',
    });
  }

  if (policy.mode === 'local' && !options.isLoopbackHost && policy.token) {
    diagnostics.push({
      level: 'warning',
      message:
        `Binding ${options.host}: NetPro is reachable from your network. Remote callers ` +
        'must present the local access token (`netpro token`), and NetPro trusts no ' +
        'forwarded headers, so a reverse proxy must pass the token through.',
    });
  }

  return diagnostics;
}
