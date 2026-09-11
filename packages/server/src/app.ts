// packages/server/src/app.ts
//
// Application composition root for @netpro/server.
// Wires config, database, jobs, events, and the HTTP request handler.
// Contains no domain business logic — that stays in @netpro/core.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  autoMigrateEnabled,
  createDb,
  runMigrations,
  type PgConn,
  type SqliteConn,
} from '@netpro/db';
import { loadAuthPolicy, type AuthPolicy } from './auth/index';
import type { ServerConfig } from './config';
import { loadConfig } from './config';
import { createEventBus, type EventBus } from './events/index';
import { createJobRegistry, type JobRegistry } from './jobs/index';
import { sendJson } from './middleware/json';
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type RateLimiter,
} from './middleware/rate-limit';
import { dispatch } from './routes/index';

export type NetProApp = {
  config: ServerConfig;
  conn: SqliteConn | PgConn;
  jobs: JobRegistry;
  events: EventBus;
  /** Phase 5 authentication policy (mode, access token, installation). */
  auth: AuthPolicy;
  /** Phase 23 per-IP rate limiter (one window set per app instance). */
  rateLimit: RateLimiter;
  /** Phase 23 origin allow-list (`null` = loopback-only) and HSTS switch. */
  security: { allowedOrigins: string[] | null; hsts: boolean };
  /** Node `http.createServer` request listener. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Release DB resources (Postgres pool). */
  close: () => Promise<void>;
};

export type CreateAppOptions = {
  config?: ServerConfig;
  /** Inject a connection (tests). When omitted, createDb() is used. */
  conn?: SqliteConn | PgConn;
  /** Skip migration on create (tests that manage schema themselves). */
  skipMigrate?: boolean;
  /**
   * Environment used for DB resolution and migration policy. Defaults to
   * process.env; runServe passes its overlay so `netpro serve` and the
   * process see one identical environment.
   */
  env?: NodeJS.ProcessEnv;
  /** Inject an auth policy (tests). Defaults to loadAuthPolicy(env, mode). */
  auth?: AuthPolicy;
};

/**
 * Build a NetPro application instance.
 *
 * Does not listen on a port — call `startServer(app)` for that.
 * Does not import or depend on `apps/web` or any cloud platform API.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NetProApp> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  const conn = options.conn ?? createDb(env);
  const jobs = createJobRegistry();
  const events = createEventBus();
  // Mode comes from config (env → config.toml → local); the token and the
  // installation identity come from disk/env — see ./auth.
  const auth = options.auth ?? loadAuthPolicy(env, config.auth.mode);

  if (!options.skipMigrate) {
    // Prefer explicit app config; fall back to the shared env helper so the
    // server stays consistent with CLI / web instrumentation.
    const shouldMigrate = options.config
      ? config.autoMigrate
      : autoMigrateEnabled(env.NETPRO_AUTO_MIGRATE);
    if (shouldMigrate) await runMigrations(conn);
  }

  // Phase 23 — the limiter lives on the app so every request in this
  // process shares one window set, while tests (one app each) stay isolated.
  // Configs that predate the new fields (or come from tests) get the safe
  // defaults: loopback-only origins, 600 requests/minute/peer, no HSTS.
  const rateLimit = createRateLimiter(
    config.rateLimit ?? {
      enabled: true,
      max: DEFAULT_RATE_LIMIT_MAX,
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    }
  );
  const security = {
    allowedOrigins: config.allowedOrigins ?? null,
    hsts: config.hsts ?? false,
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res, { conn, jobs, events, auth, config, rateLimit, security }).then((handled) => {
      if (!handled && !res.headersSent) {
        sendJson(res, 404, { error: 'Not found' });
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error', message });
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  };

  const close = async (): Promise<void> => {
    if (conn.dialect === 'postgresql') {
      await conn.pool.end();
    }
  };

  return { config, conn, jobs, events, auth, rateLimit, security, handler, close };
}
