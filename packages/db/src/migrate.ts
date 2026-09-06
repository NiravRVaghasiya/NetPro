// Shared migration runner for every NetPro entry point (CLI, web startup,
// and the standalone deploy command).
//
// WHY THIS EXISTS — the Phase 5 code called drizzle's `migrate()` directly
// from each entry point. That is safe for a single long-lived process, but
// NetPro v1.0 targets Vercel, where a deployment routinely cold-starts many
// serverless instances at once against one managed Postgres database. Each
// instance then races to apply the same migrations.
//
// Measured against a real PostgreSQL 18 server with an empty database and six
// concurrent migrators (the shape of a fresh deploy taking traffic):
//
//     workers=6 ok=1 failed=5
//       -> Failed query: CREATE TABLE "account" (...)
//       -> Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
//
// Drizzle wraps the statements in a transaction, so the database was left
// consistent — but five of six requests still threw, which on Vercel is five
// failed cold starts (500s) on every deploy that carries a migration. The
// `CREATE SCHEMA IF NOT EXISTS` failure is the giveaway that this is a genuine
// race and not merely duplicate work: IF NOT EXISTS races with itself in
// Postgres because the existence check and the create are not atomic.
//
// The fix has two layers:
//
//  1. A Postgres session-level advisory lock serializes migrators across
//     processes and machines. Everyone waits, one applies, the rest observe
//     an already-migrated journal and no-op. Advisory locks are held on a
//     dedicated client and released in a finally block; if a process dies,
//     Postgres frees the lock when the connection drops, so it cannot wedge.
//  2. A per-process promise cache means concurrent requests inside a single
//     warm instance migrate at most once, not once per request.
//
// SQLite is single-writer by design and runs one local process, so it keeps
// the direct path — but it goes through the same entry point, so callers do
// not have to care which dialect they are on.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgConn, SqliteConn } from './index';

/**
 * Advisory lock key. Postgres advisory locks live in one global 64-bit
 * namespace shared by every application on the database, so the key is a
 * fixed random-looking constant rather than a low number like 1 that another
 * tool might plausibly also pick. Must never change: a different key would
 * not exclude migrators still running the previous release.
 */
const MIGRATION_LOCK_KEY = 4_027_180_651_197_143n;

/** Bounded wait for the lock, so a stuck peer surfaces as an error not a hang. */
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export type MigrationDialect = 'sqlite' | 'postgresql';

export type RunMigrationsOptions = {
  /** Override the committed migrations directory (tests). */
  migrationsFolder?: string;
  /** Bound on how long to wait for the Postgres advisory lock. */
  lockTimeoutMs?: number;
  /** Bypass the per-process cache (tests, and the standalone CLI). */
  force?: boolean;
};

const localRequire = createRequire(import.meta.url);

/**
 * Locate the committed migrations folder for a dialect.
 *
 * Resolution by package spec works from the repo and from an installed
 * dependency; the cwd-based candidates cover the standalone Docker layout
 * (cwd = /app) and a monorepo dev server started inside apps/web.
 */
export function resolveMigrationsFolder(dialect: MigrationDialect): string {
  const folderName = dialect === 'sqlite' ? 'sqlite' : 'postgres';
  const candidates: string[] = [];

  try {
    candidates.push(dirname(localRequire.resolve('@netpro/db/package.json')));
  } catch {
    // Not resolvable from this bundle context — fall through to cwd-based paths.
  }
  // This file's own package directory, for bundlers that rewrite specs but
  // keep import.meta.url meaningful.
  try {
    candidates.push(resolve(dirname(new URL(import.meta.url).pathname), '..'));
  } catch {
    // import.meta.url is not a file URL — skip.
  }
  candidates.push(join(process.cwd(), 'node_modules', '@netpro/db'));
  // Next.js standalone output copies workspace packages to <cwd>/packages/*,
  // and the Docker image runs with cwd=/app.
  candidates.push(join(process.cwd(), 'packages', 'db'));
  candidates.push(resolve(process.cwd(), '..', '..', 'packages', 'db'));

  for (const dir of candidates) {
    const folder = join(dir, 'migrations', folderName);
    if (existsSync(join(folder, 'meta', '_journal.json'))) return folder;
  }

  throw new Error(
    `Could not locate @netpro/db migrations for "${folderName}" — tried: ${candidates.join(', ')}`
  );
}

/**
 * Is automatic migration-on-startup enabled?
 *
 * Defaults to on, preserving CLI and self-hosted behaviour. Operators running
 * migrations as an explicit deploy step (the recommended Vercel setup, where
 * `netpro-migrate` runs once at build time instead of on every cold start)
 * set NETPRO_AUTO_MIGRATE=false so request paths never attempt DDL at all.
 */
export function autoMigrateEnabled(
  value = process.env.NETPRO_AUTO_MIGRATE
): boolean {
  if (value === undefined) return true;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

async function migrateSqlite(
  conn: SqliteConn,
  migrationsFolder: string
): Promise<void> {
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(conn.db, { migrationsFolder });
}

/**
 * Apply Postgres migrations under an advisory lock.
 *
 * The lock is taken on a dedicated pool client so it is scoped to one session
 * and cannot be handed to an unrelated query, and `pg_advisory_unlock` runs in
 * a finally block. Releasing the client after unlocking returns it to the pool
 * clean.
 */
async function migratePostgres(
  conn: PgConn,
  migrationsFolder: string,
  lockTimeoutMs: number
): Promise<void> {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const client = await conn.pool.connect();
  let locked = false;
  try {
    // lock_timeout bounds the pg_advisory_lock wait so a wedged peer fails
    // loudly instead of hanging a serverless invocation until its platform
    // timeout. It is a session setting on this client only.
    await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    locked = true;
    await migrate(conn.db, { migrationsFolder });
  } finally {
    if (locked) {
      // Best effort: if the connection already died, Postgres has released
      // the lock for us and there is nothing left to clean up.
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_LOCK_KEY.toString(),
        ]);
      } catch {
        // Ignore — see above.
      }
    }
    client.release();
  }
}

/** Per-process cache, keyed by connection object identity. */
const inFlight = new WeakMap<object, Promise<void>>();

/**
 * Apply all pending migrations for `conn`, exactly once per process and
 * safely under concurrency. Idempotent: a no-op when nothing is pending.
 */
export function runMigrations(
  conn: SqliteConn | PgConn,
  options: RunMigrationsOptions = {}
): Promise<void> {
  if (!options.force) {
    const existing = inFlight.get(conn);
    if (existing) return existing;
  }

  const folder =
    options.migrationsFolder ?? resolveMigrationsFolder(conn.dialect);

  const promise = (
    conn.dialect === 'sqlite'
      ? migrateSqlite(conn, folder)
      : migratePostgres(conn, folder, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  ).catch((error: unknown) => {
    // Never cache a failure: the next caller should be able to retry, e.g.
    // after a transient connection error during a cold start.
    inFlight.delete(conn);
    throw error;
  });

  if (!options.force) inFlight.set(conn, promise);
  return promise;
}

/**
 * Report the applied-migration count without applying anything. Used by the
 * deploy command and the health endpoint's `?verbose` mode to distinguish
 * "database reachable" from "database actually migrated".
 */
export async function appliedMigrationCount(
  conn: SqliteConn | PgConn
): Promise<number> {
  if (conn.dialect === 'sqlite') {
    const rows = conn.db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM __drizzle_migrations`
    );
    return Number(rows[0]?.n ?? 0);
  }
  const result = await conn.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Number of migrations committed on disk for this dialect.
 *
 * Reads the journal with readFileSync rather than require(): a dynamic
 * require() of a computed path cannot be statically analyzed, and Turbopack
 * fails the Next.js build with "Module not found: Can't resolve <dynamic>".
 */
export function pendingMigrationTotal(
  dialect: MigrationDialect,
  migrationsFolder = resolveMigrationsFolder(dialect)
): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries?: unknown[] };
  return journal.entries?.length ?? 0;
}
