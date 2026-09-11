// Phase 23 — security headers and the CORS origin policy.
//
// The standalone server is one origin among many on the user's machine: the
// browser, a local proxy, other tools. The policy keeps that boundary honest:
//   • hardening headers on every response (sniffing, clickjacking, referrer);
//   • HSTS only behind TLS — sending it over plain HTTP would be a lie;
//   • a strict Content-Security-Policy on the server-rendered console pages,
//     whose inline scripts are static and therefore allow-listable;
//   • CORS that defaults to loopback origins only: a `netpro serve --host
//     0.0.0.0` whose UI runs at http://localhost:3000 keeps working, while a
//     random internet page cannot make credentialed API calls. Remote UIs
//     must be named explicitly via NETPRO_ALLOWED_ORIGINS (or the
//     config-file `allowed_origins`), never via a reflected `*`.

import type { ServerResponse } from 'node:http';

export const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';

// The console pages are static inline HTML/CSS/JS with no external assets and
// a same-origin EventSource: 'self' plus inline is everything they need.
export const CONSOLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'";

/** Hardening headers applied to every response. Safe for loopback and remote. */
export function applySecurityHeaders(res: ServerResponse, opts: { hsts?: boolean } = {}): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (opts.hsts) {
    res.setHeader('Strict-Transport-Security', HSTS_HEADER_VALUE);
  }
}

/** Strict CSP for the server-rendered console pages (see CONSOLE_CSP). */
export function applyConsoleCsp(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CONSOLE_CSP);
}

/**
 * Parse a comma-separated origin allow-list. Returns null when unset/empty
 * (the default loopback-only policy applies), otherwise the trimmed origins.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return list.length > 0 ? list : null;
}

/**
 * Resolve the effective allow-list: NETPRO_ALLOWED_ORIGINS wins over the
 * config-file value; null means "no explicit list" (loopback-only default).
 */
export function resolveAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
  fileValue?: string
): string[] | null {
  return (
    parseAllowedOrigins(env.NETPRO_ALLOWED_ORIGINS) ??
    (fileValue !== undefined ? parseAllowedOrigins(fileValue) : null)
  );
}

/** True for localhost, 127/8 (incl. IPv4-mapped IPv6), and ::1. */
export function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    // Strict 127/8 match — a bare startsWith would admit 127.0.0.1.evil.com.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) ||
    // Node may report IPv4 peers on a dual-stack socket as ::ffff:127.0.0.1.
    bare === '::ffff:127.0.0.1' ||
    bare.startsWith('::ffff:7f00:')
  );
}

/**
 * True when a browser at `origin` may call the API:
 * - with an explicit allow-list: exact membership (no wildcards, no suffixes);
 * - otherwise: loopback origins only (the local-first default).
 */
export function isOriginAllowed(origin: string, allowedOrigins: string[] | null): boolean {
  const candidate = origin.trim();
  if (allowedOrigins) return allowedOrigins.includes(candidate);
  return isLoopbackOrigin(candidate);
}
