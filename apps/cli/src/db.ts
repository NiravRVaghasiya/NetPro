import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { SqliteConn, PgConn } from '@netpro/db';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';

const localRequire = createRequire(import.meta.url);

/**
 * Locate the committed migrations folder in @netpro/db. Resolution by spec
 * works when running from the repo (the normal case — the workspace symlink
 * is resolved by require.resolve), with cwd-based candidates as fallback for
 * non-monorepo layouts.
 */
function migrationsFolder(dialect: 'sqlite' | 'postgresql'): string {
  const folderName = dialect === 'sqlite' ? 'sqlite' : 'postgres';
  const candidates: string[] = [];

  try {
    candidates.push(dirname(localRequire.resolve('@netpro/db/package.json')));
  } catch {
    // Not resolvable from this context — fall through to cwd-based paths.
  }
  candidates.push(join(process.cwd(), 'node_modules', '@netpro/db'));
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
 * createDb() plus auto-apply of pending migrations. Per the "DB & Pipeline
 * Deep Dive" blueprint's migration strategy, the CLI auto-runs pending
 * migrations on startup. Application is journal-based and idempotent (a
 * no-op once applied), and deliberately unconfirmed: the CLI is designed to
 * be cron/script-friendly, and no migration in this phase is breaking.
 *
 * `createDb` is imported dynamically (not statically) so that commands that
 * don't touch the database — `--help`, `config` — never load the
 * better-sqlite3/pg native modules. Same pattern as the scaffold's command
 * actions.
 */
export async function openDb(): Promise<SqliteConn | PgConn> {
  const { createDb } = await import('@netpro/db');
  const conn = createDb();

  if (conn.dialect === 'sqlite') {
    migrateSqlite(conn.db, { migrationsFolder: migrationsFolder('sqlite') });
    return conn;
  }

  await migratePg(conn.db, { migrationsFolder: migrationsFolder('postgresql') });
  return conn;
}
