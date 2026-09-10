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
  resolveAuthMode,
  resolveDatabaseConfig,
  resolveDialectStep,
  type DatabaseConfig,
} from './local';

export * as sqliteSchema from './schema.sqlite';
export * as pgSchema from './schema.pg';

// Phase 3 (local-first): install-directory layout, config.toml, and database
// resolution shared by the CLI, the local server, and the web app.
export {
  AUTH_MODES,
  configTomlPath,
  DEFAULT_AUTH_MODE,
  defaultSqlitePath,
  describeDatabaseConfig,
  ensureNetProHome,
  ensureSqliteDir,
  expandHomePath,
  LocalConfigError,
  netproHome,
  parseAuthMode,
  parseToml,
  readLocalConfig,
  redactPostgresUrl,
  resolveAuthMode,
  resolveDatabaseConfig,
  resolveDialectStep,
  resolveSqlitePath,
  type AuthMode,
  type DbDialect,
  type DatabaseConfig,
  type LocalAuthMode,
  type LocalConfig,
  type LocalInstallationConfig,
  type TomlTable,
  type TomlValue,
} from './local';

// Phase 5 (local-first): the installation identity and local API token that
// replace "GitHub OAuth is the identity system".
export {
  ACCESS_TOKEN_PREFIX,
  INSTALLATION_ID_PREFIX,
  accessTokenPath,
  ensureAccessToken,
  ensureInstallationIdentity,
  generateAccessToken,
  generateInstallationId,
  readAccessToken,
  readInstallationIdentity,
  redactAccessToken,
  resolveAccessToken,
  upsertInstallationSection,
  writeAccessToken,
  writeInstallationIdentity,
  type EnsureAccessTokenResult,
  type EnsureIdentityOptions,
  type EnsureIdentityResult,
  type InstallationIdentity,
} from './identity';

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
 * `DB_DIALECT` env → `~/.netpro/config.toml` `[database] dialect` → sqlite.
 * The implicit default is sqlite, so the local-first workflow works with zero
 * configuration, and PostgreSQL is always an explicit choice
 * (`DB_DIALECT=postgresql` or `[database] dialect`).
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
 * most common self-hosting failure:
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
 * A long-lived server (local `netpro serve`, Docker, a VM) keeps one pool and
 * a roomier default. Where many short-lived instances each hold their own
 * pool — containers scaled horizontally, function-style runtimes — a large
 * per-instance pool multiplies into connection exhaustion on the database
 * (Supabase's free tier allows ~60 direct connections), so those deployments
 * set `NETPRO_SERVERLESS=1` (a small pool) and/or point DATABASE_URL at a
 * pooled endpoint where the provider offers one (pgbouncer, 6543).
 *
 * Phase 4: this is an explicit switch rather than a guess from a hosting
 * platform's environment variables — the deployment states its own shape.
 */
export function resolvePoolConfig(env: NodeJS.ProcessEnv = process.env): {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
} {
  const serverless = isServerlessRuntime(env);
  return {
    max: positiveInt(env.NETPRO_DB_POOL_MAX, serverless ? 1 : 10),
    idleTimeoutMillis: positiveInt(env.NETPRO_DB_POOL_IDLE_MS, serverless ? 10_000 : 30_000),
    connectionTimeoutMillis: positiveInt(env.NETPRO_DB_CONNECT_TIMEOUT_MS, 10_000),
  };
}

/**
 * Is this process running as one of many short-lived instances?
 *
 * Opt in with `NETPRO_SERVERLESS=1` (or the conventional `FUNCTION_TARGET`
 * family of variables set by function runtimes). Unset — the local-first
 * default — means a long-lived server with one pool.
 */
export function isServerlessRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.NETPRO_SERVERLESS?.trim().toLowerCase();
  if (explicit) return !/^(0|false|no|off)$/.test(explicit);
  return Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.FUNCTION_TARGET);
}

export function createDb(env: NodeJS.ProcessEnv = process.env): SqliteConn | PgConn {
  const config = resolveDatabaseConfig(env);

  if (config.dialect === 'sqlite') {
    const path = config.path!;
    // Phase 4: no hosted-platform guard rail. Whether SQLite is appropriate is
    // the operator's call and is answered in the docs (it needs a persistent
    // filesystem); guessing from a platform's environment variables made the
    // database dialect depend on where the process happened to run.
    //
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
