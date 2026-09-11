import type { Command } from 'commander';
import type { PgConn, SqliteConn } from '@netpro/db';

export interface MigrateCommandOptions {
  status?: boolean;
  /**
   * Skip the automatic pre-migration backup. SQLite only — set by
   * `--no-backup`. The default backup is the recoverability half of Phase 22:
   * a migration that goes wrong is one `netpro restore` away from fixed.
   */
  backup?: boolean;
}

export interface MigrateResult {
  dialect: 'sqlite' | 'postgresql';
  applied: number;
  total: number;
  changed: number;
  /** Pre-migration safety copy, or null when none was taken. */
  backupPath: string | null;
  output: string;
}

/**
 * `netpro migrate` — apply pending migrations as an explicit, observable step.
 *
 * Phase 6 exists partly because migration-on-startup is the wrong model where
 * several instances start at once: each one races to run the same DDL.
 * (Multi-instance PostgreSQL is safe — the runner takes an advisory lock — but
 * it is wasted work and it hides failures in request paths.) The recommended
 * production setup is to run this command once as a release/build step and set
 * NETPRO_AUTO_MIGRATE=false so instances never attempt DDL at all. It is also
 * the right tool for a Docker init container or the compose `migrate` service.
 *
 * Unlike the implicit startup migration, this reports what it did and fails
 * loudly, so a deploy pipeline stops rather than shipping an application
 * against a schema it does not have.
 */
export async function executeMigrate(
  options: MigrateCommandOptions,
  conn: SqliteConn | PgConn,
  env: NodeJS.ProcessEnv = process.env
): Promise<MigrateResult> {
  const { appliedMigrationCount, pendingMigrationTotal, runMigrations } = await import(
    '@netpro/db'
  );

  const dialect = conn.dialect;
  const total = pendingMigrationTotal(dialect);
  const before = await appliedMigrationCount(conn).catch(() => 0);

  if (options.status) {
    const pending = Math.max(0, total - before);
    return {
      dialect,
      applied: before,
      total,
      backupPath: null,
      changed: 0,
      output:
        `Dialect:  ${dialect}\n` +
        `Applied:  ${before}/${total}\n` +
        `Pending:  ${pending}` +
        (pending > 0 ? '\n\nRun `netpro migrate` to apply them.' : ''),
    };
  }

  // Phase 22 — back up before mutating. Only SQLite file databases qualify:
  // :memory: has nothing to preserve, PostgreSQL dumps belong to `netpro
  // backup` (pg_dump to a custom archive takes minutes on large teams, which
  // is not something a deploy step should do unasked), and a no-op run takes
  // no backup at all. A failed backup fails the migration loudly — migrating
  // without the safety net is exactly what this step exists to prevent.
  let backupPath: string | null = null;
  const pending = Math.max(0, total - before);
  if (options.backup !== false && pending > 0 && conn.dialect === 'sqlite') {
    const {
      backupDir,
      backupSqlite,
      defaultBackupFilename,
      ensureBackupDir,
      sqliteFileOf,
    } = await import('@netpro/db');
    if (sqliteFileOf(conn) !== null) {
      const { join } = await import('node:path');
      const dest = join(
        ensureBackupDir(env),
        defaultBackupFilename('sqlite', new Date(), 'pre-migrate')
      );
      try {
        backupPath = (await backupSqlite(conn, dest)).path;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Refusing to migrate without a backup: ${detail} ` +
            `(backups live in ${backupDir(env)}; pass --no-backup to override).`,
          { cause: error }
        );
      }
    }
  }

  // `force` bypasses the per-process cache: this command's whole job is to do
  // the work, not to observe that something else already scheduled it.
  await runMigrations(conn, { force: true });
  const applied = await appliedMigrationCount(conn);
  const changed = Math.max(0, applied - before);

  if (applied < total) {
    throw new Error(
      `Only ${applied}/${total} migrations are applied after a successful run — ` +
        'the database may be shared with a newer deployment.'
    );
  }

  return {
    dialect,
    applied,
    total,
    changed,
    backupPath,
    output:
      (changed === 0
        ? `✓ Database is already up to date (${applied}/${total} migrations, ${dialect}).`
        : `✓ Applied ${changed} migration${changed === 1 ? '' : 's'} (${applied}/${total}, ${dialect}).`) +
      (backupPath ? `\n  Pre-migration backup: ${backupPath}` : ''),
  };
}

/** Turn the failures operators actually hit into actionable advice. */
export function migrationHint(message: string): string | null {
  if (/DATABASE_URL is required/.test(message)) {
    return 'Set DATABASE_URL (and DB_DIALECT=postgresql) to your managed Postgres database.';
  }
  if (/SELF_SIGNED_CERT|self[- ]signed certificate|unable to verify/i.test(message)) {
    return (
      'TLS verification failed. Append ?sslmode=require to DATABASE_URL for providers that ' +
      'use their own CA (Supabase, Neon), or set NETPRO_DB_SSL_CA to the CA certificate.'
    );
  }
  if (/does not support SSL|server does not support/i.test(message)) {
    return 'The server has no TLS. Append ?sslmode=disable to DATABASE_URL for a private-network database.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(message)) {
    return 'The database is unreachable. Check the host, port, and any IP allow list.';
  }
  if (/lock_timeout|canceling statement due to lock timeout/i.test(message)) {
    return 'Timed out waiting for the migration advisory lock — another deploy is likely migrating. Retry shortly.';
  }
  return null;
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Apply pending database migrations (deploy step)')
    .option('--status', 'Report applied/pending migrations without changing anything')
    .option('--no-backup', 'Skip the automatic pre-migration backup (SQLite)')
    .action(async (options: MigrateCommandOptions) => {
      // Imported lazily so `--help` never loads the native database drivers.
      const { createDb } = await import('@netpro/db');
      // createDb() is inside the try: a misconfigured DATABASE_URL is the most
      // common failure here, and it should produce the actionable hint below,
      // not an unhandled stack trace.
      let conn: SqliteConn | PgConn | undefined;
      try {
        conn = createDb();
        const result = await executeMigrate(options, conn);
        console.log(result.output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ Migration failed: ${message}`);
        const hint = migrationHint(message);
        if (hint) console.error(`  ${hint}`);
        process.exitCode = 1;
      } finally {
        if (conn?.dialect === 'postgresql') await conn.pool.end().catch(() => {});
      }
    });
}
