// packages/server/src/config.ts
//
// Server configuration for the local-first NetPro HTTP process.
// Defaults match the Phase 2 plan (127.0.0.1:3777). Binding to 0.0.0.0 is
// never the default — remote exposure must be explicit.
//
// Phase 3: settings can also come from `~/.netpro/config.toml`:
//
//     [server]
//     host = "127.0.0.1"
//     port = 3777
//
//     [auth]
//     mode = "local"          # local | token | open (Phase 5)
//
// Precedence (highest wins): environment → config.toml → defaults.
// Environment keeps parity with the pre-config-file behaviour and with every
// process manager (systemd, Docker, Compose) that speaks env vars natively.
//
// This module resolves *ordinary* settings only. The access token and
// installation identity are resolved by `./auth` at app-creation time, so
// `loadConfig()` stays a pure function of env + config.toml that tests can
// call with an empty environment.

import { readLocalConfig } from '@netpro/db';
import { resolveAuthMode, type AuthMode } from './auth/index';
import { resolveAllowedOrigins } from './middleware/security';
import { resolveRateLimitConfig, type RateLimitConfig } from './middleware/rate-limit';

export type ServerConfig = {
  /** Bind address. Default 127.0.0.1 (local-only). */
  host: string;
  /** TCP port. Default 3777. */
  port: number;
  /**
   * When true, auto-apply pending DB migrations on startup.
   * Mirrors NETPRO_AUTO_MIGRATE used by the CLI and web instrumentation.
   */
  autoMigrate: boolean;
  /**
   * Phase 5 authentication policy mode. The token and installation identity
   * live in `./auth` (`loadAuthPolicy`), because they come from disk
   * (`~/.netpro/keys/access-token`, `[installation]`) rather than from
   * configuration an operator edits by hand.
   */
  auth: { mode: AuthMode };
  /**
   * Phase 23 — explicit CORS allow-list. `null` (or absent) selects the
   * loopback-only default: browsers on the machine keep working, random
   * internet pages cannot call the API. `loadConfig()` always resolves this
   * from `NETPRO_ALLOWED_ORIGINS` (winning) or the config-file
   * `allowed_origins`; other constructors may omit it for the default.
   */
  allowedOrigins?: string[] | null;
  /** Phase 23 — per-IP rate limiting. `loadConfig()` resolves it; absent means the default 600/min. */
  rateLimit?: RateLimitConfig;
  /** Phase 23 — send HSTS. Opt-in, and only meaningful behind a TLS-terminating proxy. */
  hsts?: boolean;
  /**
   * Where the separate Web UI (apps/web, a pure client of this server) is
   * reachable, when the operator runs one. This process never serves that UI:
   * the value exists so `netpro serve` can point at the real address instead
   * of implying its own port is the UI. `null` means "no Web UI configured".
   */
  webUrl?: string | null;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3777;

/**
 * Resolve the optional Web UI address (`NETPRO_WEB_URL`, else `[server]
 * web_url`). Returns null when unset or unparseable — the banner then tells
 * the user how to start a UI rather than printing a broken link.
 */
export function resolveWebUrl(
  env: NodeJS.ProcessEnv = process.env,
  fileValue?: string
): string | null {
  const raw = (env.NETPRO_WEB_URL ?? '').trim() || (fileValue ?? '').trim();
  if (raw === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Normalised so callers can append paths without double slashes.
  return parsed.toString().replace(/\/$/, '');
}

function positivePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return Math.floor(n);
}

/**
 * Resolve server config from environment plus `~/.netpro/config.toml`.
 *
 * Recognised environment variables:
 * - `NETPRO_HOST` / `HOST` — bind address (default 127.0.0.1)
 * - `NETPRO_PORT` / `PORT` — TCP port (default 3777)
 * - `NETPRO_AUTO_MIGRATE` — same semantics as @netpro/db
 * - `NETPRO_AUTH_MODE` — `local` (default) | `token` | `open`
 * - `NETPRO_HOME` — relocate the install directory (see @netpro/db)
 * - `NETPRO_ALLOWED_ORIGINS` — CSV CORS allow-list (default: loopback only)
 * - `NETPRO_RATE_LIMIT_ENABLED` / `NETPRO_RATE_LIMIT_MAX` / `NETPRO_RATE_LIMIT_WINDOW_MS`
 * - `NETPRO_HSTS` — send Strict-Transport-Security (behind TLS only)
 * - `NETPRO_WEB_URL` — where the separate Web UI runs (banner display only)
 *
 * No cloud-platform, AUTH_URL, or GitHub OAuth variables are required.
 *
 * An invalid config.toml is a loud error, not a silently-ignored file: a typo
 * in `[server] port` should stop the server, not strand the user on 3777.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // readLocalConfig throws (with file + line context) on an invalid
  // config.toml — that is deliberate: fail loudly rather than strand the
  // user on default settings they believe they changed.
  const file = readLocalConfig(env);
  const fileHost = file.server?.host;
  const filePort = file.server?.port;

  const host =
    (env.NETPRO_HOST ?? env.HOST ?? '').trim() ||
    fileHost ||
    DEFAULT_HOST;
  const port = positivePort(env.NETPRO_PORT ?? env.PORT, filePort ?? DEFAULT_PORT);

  let autoMigrate = true;
  const raw = env.NETPRO_AUTO_MIGRATE;
  if (raw !== undefined) {
    autoMigrate = !/^(0|false|no|off)$/i.test(raw.trim());
  }

  return {
    host,
    port,
    autoMigrate,
    auth: { mode: resolveAuthMode(env) },
    // Phase 23 — remote exposure is explicit: the origin allow-list, the rate
    // limiter, and HSTS resolve here so `netpro serve` is safe by default.
    allowedOrigins: resolveAllowedOrigins(env, file.server?.allowedOrigins),
    rateLimit: resolveRateLimitConfig(env),
    hsts: ['1', 'true', 'yes', 'on'].includes((env.NETPRO_HSTS ?? '').trim().toLowerCase()),
    // Display-only: the address of the separate Web UI, if the operator runs one.
    webUrl: resolveWebUrl(env, file.server?.webUrl),
  };
}

export type { AuthMode };

export const DEFAULT_SERVER_HOST = DEFAULT_HOST;
export const DEFAULT_SERVER_PORT = DEFAULT_PORT;
