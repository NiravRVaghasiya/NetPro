import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as sqliteSchema from './schema.sqlite';
import * as pgSchema from './schema.pg';

export * as sqliteSchema from './schema.sqlite';
export * as pgSchema from './schema.pg';

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

function resolveDialect(): 'sqlite' | 'postgresql' {
  const dialect = process.env.DB_DIALECT ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgresql') {
    throw new Error(`Unknown DB_DIALECT "${dialect}". Expected "sqlite" or "postgresql".`);
  }
  return dialect;
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

export function createDb(): SqliteConn | PgConn {
  const dialect = resolveDialect();

  if (dialect === 'sqlite') {
    const path = process.env.DB_PATH ?? './netpro.db';
    // Guard rail, not a preference: Vercel's filesystem is ephemeral and
    // per-instance, so a SQLite database there silently loses every write on
    // redeploy and disagrees between concurrent instances. Failing at startup
    // with an actionable message beats shipping a "working" deploy that eats
    // the user's imported network.
    if (process.env.VERCEL && !process.env.NETPRO_ALLOW_EPHEMERAL_SQLITE) {
      throw new Error(
        'DB_DIALECT=sqlite cannot be used on Vercel: its filesystem is ephemeral and ' +
          'per-instance, so data is lost on every redeploy and is not shared between ' +
          'concurrent instances. Set DB_DIALECT=postgresql and DATABASE_URL to a managed ' +
          'Postgres database. See docs/deployment.md.'
      );
    }
    const sqlite = new Database(path);
    // WAL lets readers proceed during a write, and busy_timeout makes
    // concurrent CLI/web access wait briefly rather than throwing SQLITE_BUSY.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');
    return { dialect, db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema };
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_DIALECT=postgresql');
  }
  const pool = new Pool({
    connectionString,
    ssl: resolvePgSsl(connectionString),
    ...resolvePoolConfig(),
  });
  // An idle client erroring (a provider dropping the connection, a failover)
  // emits 'error' on the pool. Without a listener Node treats it as an
  // unhandled 'error' event and terminates the process.
  pool.on('error', (error) => {
    console.error('[netpro/db] idle Postgres client error:', error.message);
  });
  return { dialect, db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema, pool };
}
