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
// Precedence (highest wins): environment → config.toml → defaults.
// Environment keeps parity with the pre-config-file behaviour and with every
// process manager (systemd, Docker, Compose) that speaks env vars natively.

import { readLocalConfig } from '@netpro/db';

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
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3777;

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
 * - `NETPRO_HOME` — relocate the install directory (see @netpro/db)
 *
 * No Vercel, AUTH_URL, or GitHub OAuth variables are required.
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

  return { host, port, autoMigrate };
}

export const DEFAULT_SERVER_HOST = DEFAULT_HOST;
export const DEFAULT_SERVER_PORT = DEFAULT_PORT;
