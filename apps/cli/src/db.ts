import type { SqliteConn, PgConn } from '@netpro/db';

/**
 * createDb() plus auto-apply of pending migrations. Per the "DB & Pipeline
 * Deep Dive" blueprint's migration strategy, the CLI auto-runs pending
 * migrations on startup. Application is journal-based and idempotent (a
 * no-op once applied), and deliberately unconfirmed: the CLI is designed to
 * be cron/script-friendly, and no migration in this phase is breaking.
 *
 * The migration runner itself lives in @netpro/db so the CLI, the web server,
 * and the standalone `netpro-migrate` deploy command share one implementation
 * — including the Postgres advisory lock that makes concurrent migrators safe
 * (see packages/db/src/migrate.ts for the measured race this prevents).
 *
 * `@netpro/db` is imported dynamically (not statically) so that commands that
 * don't touch the database — `--help`, `config` — never load the
 * better-sqlite3/pg native modules. Same pattern as the scaffold's command
 * actions.
 */
export async function openDb(): Promise<SqliteConn | PgConn> {
  const { createDb, runMigrations, autoMigrateEnabled } = await import('@netpro/db');
  const conn = createDb();

  // NETPRO_AUTO_MIGRATE=false lets an operator who runs migrations as an
  // explicit deploy step keep the CLI read-only against that database.
  if (autoMigrateEnabled()) await runMigrations(conn);
  return conn;
}
