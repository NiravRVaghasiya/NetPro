import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as sqliteSchema from './schema.sqlite';
import * as pgSchema from './schema.pg';
import {
  describeDatabaseConfig,
  ensureSqliteDir,
  redactPostgresUrl,
  resolveDatabaseConfig,
  resolveDialectStep,
  type DatabaseConfig,
} from './local';

export * as sqliteSchema from './schema.sqlite';
export * as pgSchema from './schema.pg';

// Phase 3 (local-first): install-directory layout, config.toml, and database
// resolution shared by the CLI, the local server, and the web app.
export {
  configTomlPath,
  defaultSqlitePath,
  describeDatabaseConfig,
  ensureNetProHome,
  ensureSqliteDir,
  expandHomePath,
  LocalConfigError,
  netproHome,
  parseToml,
  readLocalConfig,
  redactPostgresUrl,
  resolveDatabaseConfig,
  resolveDialectStep,
  resolveSqlitePath,
  type DbDialect,
  type DatabaseConfig,
  type LocalConfig,
  type TomlTable,
  type TomlValue,
} from './local';

export {
  appliedMigrationCount,
  autoMigrateEnabled,
  pendingMigrationTotal,
  resolveMigrationsFolder,
  runMigrations,
  type MigrationDialect,
  type RunMigrationsOptions,
} from './migrate';

export type SqliteConn = {
  dialect: 'sqlite';
  db: BetterSQLite3Database<typeof sqliteSchema>;
  schema: typeof sqliteSchema;
};

export type PgConn = {
  dialect: 'postgresql';
  db: NodePgDatabase<typeof pgSchema>;
  schema: typeof pgSchema;
  /**
   * The underlying pool. Exposed so the migration runner can take an advisory
   * lock on a single dedicated session, and so long-lived processes can close
   * the pool on shutdown.
   */
  pool: Pool;
};

/**
 * Which database dialect should this process use?
 *
 * Delegates to the shared Phase 3 resolver (`./local`), which layers:
 * `DB_DIALECT` env → `~/.netpro/config.toml` `[database] dialect` → Vercel
 * inference → sqlite. The implicit default is sqlite, so the local-first
 * workflow works with zero configuration.
 *
 * The one inference: on Vercel with a `DATABASE_URL` but no `DB_DIALECT`,
 * default to postgresql. Sqlite is never usable there (see the guard in
 * createDb), and the managed-Postgres integrations (Neon, Supabase, Vercel
 * Postgres) attach exactly one variable — `DATABASE_URL` — without a
 * dialect. Without the inference, `next build` evaluates this module during
 * page-data collection, resolves sqlite, and the deploy dies on the guard
 * below *after* the build-time migration already succeeded against the same
 * database. With it, connecting a database and redeploying just works.
 *
 * Tolerant of a missing Postgres connection string: "which dialect?" can be
 * asked without "is it usable?" — createDb() raises that error with
 * actionable text.
 */
export function resolveDialect(env: NodeJS.ProcessEnv = process.env): 'sqlite' | 'postgresql' {
  return resolveDialectStep(env).dialect;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Should this connection negotiate TLS, and should it verify the server
 * certificate?
 *
 * Managed Postgres providers differ here, and getting it wrong is the single
 * most common self-hosting/Vercel deploy failure:
 *
 *  - Supabase, Neon, and most hosted providers require TLS. Many present
 *    certificates signed by their own CA, which Node does not trust by
 *    default, producing `SELF_SIGNED_CERT_IN_CHAIN`. They document appending
 *    `?sslmode=require` to the URL, which in libpq semantics means "encrypt,
 *    do not verify the certificate".
 *  - A `docker compose` Postgres on a private network usually has no TLS at
 *    all, and forcing it produces "server does not support SSL connections".
 *
 * `pg` does not implement libpq's sslmode itself, so NetPro maps it here
 * explicitly rather than leaving operators to discover the difference.
 * `sslmode=verify-full` (or NETPRO_DB_SSL_CA) opts into real verification.
 */
export function resolvePgSsl(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env
): PoolConfig['ssl'] {
  const ca = env.NETPRO_DB_SSL_CA?.trim();
  let sslmode: string | null = null;
  try {
    sslmode = new URL(connectionString).searchParams.get('sslmode');
  } catch {
    // Not a parseable URL (e.g. a libpq key=value DSN) — fall back to env.
  }
  const mode = (sslmode ?? env.PGSSLMODE ?? '').trim().toLowerCase();

  if (mode === 'disable') return false;
  if (ca) return { ca, rejectUnauthorized: true };
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  if (mode === 'require' || mode === 'prefer' || mode === 'allow') {
    // Encrypted, but the provider's CA is not in Node's trust store. This is
    // what the providers' own copy-paste connection strings mean.
    return { rejectUnauthorized: false };
  }
  return undefined; // No sslmode given: let pg/the server decide (plain local Postgres).
}

/**
 * Pool sizing for the runtime.
 *
 * On serverless each instance holds its own pool, and instances scale out
 * horizontally, so a large per-instance pool multiplies into connection
 * exhaustion on the database (Supabase's free tier allows ~60 direct
 * connections). Small pools per instance, plus a pooled connection string
 * where the provider offers one (pgbouncer), is the correct shape. Long-lived
 * servers (Docker, `next start`) keep a roomier default.
 */
export function resolvePoolConfig(env: NodeJS.ProcessEnv = process.env): {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
} {
  const serverless = Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);
  return {
    max: positiveInt(env.NETPRO_DB_POOL_MAX, serverless ? 1 : 10),
    idleTimeoutMillis: positiveInt(env.NETPRO_DB_POOL_IDLE_MS, serverless ? 10_000 : 30_000),
    connectionTimeoutMillis: positiveInt(env.NETPRO_DB_CONNECT_TIMEOUT_MS, 10_000),
  };
}

export function createDb(env: NodeJS.ProcessEnv = process.env): SqliteConn | PgConn {
  const config = resolveDatabaseConfig(env);

  if (config.dialect === 'sqlite') {
    const path = config.path!;
    // Guard rail, not a preference: Vercel's filesystem is ephemeral and
    // per-instance, so a SQLite database there silently loses every write on
    // redeploy and disagrees between concurrent instances. Failing at startup
    // with an actionable message beats shipping a "working" deploy that eats
    // the user's imported network.
    if (env.VERCEL && !env.NETPRO_ALLOW_EPHEMERAL_SQLITE) {
      throw new Error(
        'DB_DIALECT=sqlite cannot be used on Vercel: its filesystem is ephemeral and ' +
          'per-instance, so data is lost on every redeploy and is not shared between ' +
          'concurrent instances. Attach a managed Postgres database (Vercel Postgres, ' +
          'Neon, Supabase — its DATABASE_URL is detected automatically), or set ' +
          'DB_DIALECT=postgresql and DATABASE_URL. See docs/deployment.md.'
      );
    }
    // Phase 3: the local-first default lives at ~/.netpro/netpro.db, which
    // does not exist until `netpro init` (or this call) creates it.
    ensureSqliteDir(path);
    const sqlite = new Database(path);
    // WAL lets readers proceed during a write, and busy_timeout makes
    // concurrent CLI/web access wait briefly rather than throwing SQLITE_BUSY.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');
    return { dialect: config.dialect, db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema };
  }

  const connectionString = config.url;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_DIALECT=postgresql');
  }
  const pool = new Pool({
    connectionString,
    ssl: resolvePgSsl(connectionString, env),
    ...resolvePoolConfig(env),
  });
  // An idle client erroring (a provider dropping the connection, a failover)
  // emits 'error' on the pool. Without a listener Node treats it as an
  // unhandled 'error' event and terminates the process.
  pool.on('error', (error) => {
    console.error('[netpro/db] idle Postgres client error:', error.message);
  });
  return { dialect: config.dialect, db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema, pool };
}

/**
 * Human-readable description of where a connection's data lives, safe to
 * print: SQLite shows a `~`-abbreviated path, PostgreSQL has its credentials
 * redacted. Used by `netpro serve`, `netpro init`, and `netpro status`.
 */
export function describeConn(
  conn: SqliteConn | PgConn,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (conn.dialect === 'sqlite') {
    // drizzle stores the underlying better-sqlite3 handle as $client, whose
    // `.name` is the file path handed to `new Database(path)`.
    const client = (conn.db as unknown as { $client?: { name?: unknown } }).$client;
    const name = typeof client?.name === 'string' ? client.name : undefined;
    if (!name || name === ':memory:') return ':memory:';
    return describeDatabaseConfig({ dialect: 'sqlite', path: name, source: 'env' }, env);
  }
  const connectionString = conn.pool.options?.connectionString ?? '';
  return redactPostgresUrl(connectionString);
}

/**
 * Release a connection's underlying resources (SQLite file handle, Postgres
 * pool). One-shot commands (`netpro init`, `netpro status`) use this so tests
 * and long-lived wrappers do not leak handles.
 */
export async function closeConn(conn: SqliteConn | PgConn): Promise<void> {
  if (conn.dialect === 'sqlite') {
    const client = (conn.db as unknown as { $client?: { close?: () => void } }).$client;
    client?.close?.();
    return;
  }
  await conn.pool.end().catch(() => {});
}
