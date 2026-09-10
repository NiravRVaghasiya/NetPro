import type { Command } from 'commander';
import type { PgConn, SqliteConn } from '@netpro/db';

export interface MigrateCommandOptions {
  status?: boolean;
}

export interface MigrateResult {
  dialect: 'sqlite' | 'postgresql';
  applied: number;
  total: number;
  changed: number;
  output: string;
}

/**
 * `netpro migrate` — apply pending migrations as an explicit, observable step.
 *
 * Phase 6 exists partly because migration-on-startup is the wrong model for
 * serverless: many instances cold-start concurrently
 * one races to run the same DDL. The recommended production setup is to run
 * this command once from the build step and set NETPRO_AUTO_MIGRATE=false so
 * request paths never attempt DDL at all. It is also the right tool for a
 * Docker init container or `docker compose run --rm web netpro migrate`.
 *
 * Unlike the implicit startup migration, this reports what it did and fails
 * loudly, so a deploy pipeline stops rather than shipping an application
 * against a schema it does not have.
 */
export async function executeMigrate(
  options: MigrateCommandOptions,
  conn: SqliteConn | PgConn
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
      changed: 0,
      output:
        `Dialect:  ${dialect}\n` +
        `Applied:  ${before}/${total}\n` +
        `Pending:  ${pending}` +
        (pending > 0 ? '\n\nRun `netpro migrate` to apply them.' : ''),
    };
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
    output:
      changed === 0
        ? `✓ Database is already up to date (${applied}/${total} migrations, ${dialect}).`
        : `✓ Applied ${changed} migration${changed === 1 ? '' : 's'} (${applied}/${total}, ${dialect}).`,
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
