// packages/server/src/config.ts
//
// Server configuration for the local-first NetPro HTTP process.
// Defaults match the Phase 2 plan (127.0.0.1:3777). Binding to 0.0.0.0 is
// never the default — remote exposure must be explicit.

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
 * Resolve server config from environment.
 *
 * Recognised variables:
 * - `NETPRO_HOST` / `HOST` — bind address (default 127.0.0.1)
 * - `NETPRO_PORT` / `PORT` — TCP port (default 3777)
 * - `NETPRO_AUTO_MIGRATE` — same semantics as @netpro/db
 *
 * No Vercel, AUTH_URL, or GitHub OAuth variables are required.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = (env.NETPRO_HOST ?? env.HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = positivePort(env.NETPRO_PORT ?? env.PORT, DEFAULT_PORT);

  let autoMigrate = true;
  const raw = env.NETPRO_AUTO_MIGRATE;
  if (raw !== undefined) {
    autoMigrate = !/^(0|false|no|off)$/i.test(raw.trim());
  }

  return { host, port, autoMigrate };
}

export const DEFAULT_SERVER_HOST = DEFAULT_HOST;
export const DEFAULT_SERVER_PORT = DEFAULT_PORT;
