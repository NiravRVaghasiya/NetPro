import type { Command } from 'commander';
import type { BackupEntry, ExecFn } from '@netpro/db';

export interface BackupCommandOptions {
  /** Write to this path instead of a timestamped file in the backup directory. */
  output?: string;
  /** Replace the destination when it already exists. */
  force?: boolean;
  /** List available backups instead of creating one. */
  list?: boolean;
}

export interface BackupCommandResult {
  dialect: 'sqlite' | 'postgresql' | null;
  /** Absolute path written (absent for --list). */
  path?: string;
  bytes?: number;
  listed?: BackupEntry[];
  output: string;
}

export interface RestoreCommandResult {
  dialect: 'sqlite' | 'postgresql';
  restored: string;
  /** SQLite only: safety copy of the pre-restore database. */
  safetyBackup: string | null;
  output: string;
}

/** Test seam: inject the pg_dump/pg_restore/psql runner (production shells out). */
export interface BackupDeps {
  run?: ExecFn;
  now?: Date;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * `netpro backup` — snapshot the database into `<home>/backups/`.
 *
 * SQLite is copied through the SQLite backup API (consistent even while the
 * database is open); PostgreSQL is dumped with `pg_dump --format=custom`.
 * A backup never migrates first: it snapshots exactly what is on disk, and
 * the file is stored mode 0600 like the live database (Phase 23).
 */
export async function executeBackup(
  options: BackupCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
  deps: BackupDeps = {}
): Promise<BackupCommandResult> {
  const {
    backupDir,
    backupPostgres,
    backupSqlite,
    closeConn,
    createDb,
    defaultBackupFilename,
    ensureBackupDir,
    listBackups,
    resolveDatabaseConfig,
  } = await import('@netpro/db');

  if (options.list) {
    const dir = backupDir(env);
    const listed = listBackups(dir);
    if (listed.length === 0) {
      return {
        dialect: null,
        listed,
        output: `No backups in ${dir} yet.\nCreate one with \`netpro backup\`.`,
      };
    }
    const lines = listed.map(
      (entry) =>
        `- ${entry.name}  ${formatBytes(entry.bytes)}  ${new Date(entry.mtimeMs).toISOString()}`
    );
    return {
      dialect: null,
      listed,
      output: `Backups in ${dir} (${listed.length}):\n${lines.join('\n')}\n\nRestore one with \`netpro restore <file>\`.`,
    };
  }

  const config = resolveDatabaseConfig(env);
  if (config.dialect === 'sqlite') {
    const { existsSync } = await import('node:fs');
    const live = config.path!;
    if (!existsSync(live)) {
      throw new Error(`No SQLite database at ${live} — run \`netpro init\` first.`);
    }
    // createDb(), deliberately NOT openDb(): a backup snapshots what is on
    // disk and must never apply migrations as a side effect.
    const conn = createDb(env);
    if (conn.dialect !== 'sqlite') {
      throw new Error(`Expected a SQLite connection for ${live}.`);
    }
    try {
      const { join } = await import('node:path');
      const dest =
        options.output ??
        join(ensureBackupDir(env), defaultBackupFilename('sqlite', deps.now ?? new Date()));
      const result = await backupSqlite(conn, dest, { overwrite: options.force });
      return {
        dialect: 'sqlite',
        path: result.path,
        bytes: result.bytes,
        output:
          `✓ Backed up SQLite database (${formatBytes(result.bytes)}) to\n` +
          `  ${result.path}\n` +
          `Restore it with \`netpro restore ${result.path}\`.`,
      };
    } finally {
      await closeConn(conn);
    }
  }

  const { join } = await import('node:path');
  const dest =
    options.output ??
    join(ensureBackupDir(env), defaultBackupFilename('postgresql', deps.now ?? new Date()));
  const result = await backupPostgres(config.url!, dest, {
    overwrite: options.force,
    run: deps.run,
  });
  return {
    dialect: 'postgresql',
    path: result.path,
    bytes: result.bytes,
    output:
      `✓ Backed up PostgreSQL database (${formatBytes(result.bytes)}) to\n` +
      `  ${result.path}\n` +
      `Restore it with \`netpro restore ${result.path}\`.`,
  };
}

/**
 * `netpro restore <file>` — replace the live database with a backup.
 *
 * SQLite restores keep a `pre-restore-<stamp>.db` safety copy first, so the
 * wrong file is one more restore away from fixed; the backup itself is
 * validated (SQLite magic header + NetPro migration journal) before anything
 * is touched. PostgreSQL restores shell to `pg_restore`/`psql` — take a
 * `netpro backup` first, because there is no automatic safety copy there.
 *
 * Stop `netpro serve` before restoring: the running server holds the previous
 * image open and must be restarted to see the restored one.
 */
export async function executeRestore(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: BackupDeps = {}
): Promise<RestoreCommandResult> {
  const {
    appliedMigrationCount,
    closeConn,
    createDb,
    pendingMigrationTotal,
    resolveDatabaseConfig,
    restorePostgres,
    restoreSqlite,
  } = await import('@netpro/db');

  const config = resolveDatabaseConfig(env);
  if (config.dialect === 'sqlite') {
    const { restored, safetyBackup } = await restoreSqlite(config.path!, file, {
      env,
      now: deps.now,
    });
    // Verify the restored image opens and reports its own migration state.
    const conn = createDb(env);
    try {
      const applied = await appliedMigrationCount(conn).catch(() => 0);
      const total = pendingMigrationTotal(conn.dialect);
      return {
        dialect: 'sqlite',
        restored,
        safetyBackup,
        output:
          `✓ Restored SQLite database from ${file}\n` +
          `  Live: ${restored} (${applied}/${total} migrations applied)` +
          (safetyBackup ? `\n  Previous image kept as ${safetyBackup}` : '') +
          `\n  If \`netpro serve\` is running, restart it to see the restored data.`,
      };
    } finally {
      await closeConn(conn);
    }
  }

  const { kind } = await restorePostgres(config.url!, file, { run: deps.run });
  const via = kind === 'custom' ? 'pg_restore' : 'psql';
  return {
    dialect: 'postgresql',
    restored: config.url!,
    safetyBackup: null,
    output:
      `✓ Restored PostgreSQL database from ${file} (via ${via}).\n` +
      `  If \`netpro serve\` is running, restart it to see the restored data.`,
  };
}

/** Turn the failures operators actually hit into actionable advice. */
export function backupFailureHint(message: string): string | null {
  if (/DATABASE_URL is required/.test(message)) {
    return (
      'Set DATABASE_URL (and DB_DIALECT=postgresql) to your PostgreSQL server, ' +
      'or keep the default SQLite dialect — it needs no URL at all.'
    );
  }
  if (/pg_dump.*not found|pg_restore.*not found|psql.*not found/.test(message)) {
    return (
      'Install the PostgreSQL client tools (`postgresql-client`, or `brew install libpq`), ' +
      'or back up from the container: `docker compose exec -T db pg_dump -U netpro -d netpro > backup.sql`.'
    );
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(message)) {
    return 'The database is unreachable. Check the host, port, and any IP allow list.';
  }
  if (/No SQLite database at/.test(message)) {
    return 'Nothing has created this install yet — `netpro init` writes the database first.';
  }
  return null;
}

function printBackupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ ${message}`);
  const hint =
    (error as { hint?: unknown })?.hint ??
    backupFailureHint(message);
  if (typeof hint === 'string' && hint) console.error(`  ${hint}`);
}

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Back up the database to ~/.netpro/backups (SQLite snapshot or pg_dump)')
    .option('--output <path>', 'Write to this path instead of a timestamped file')
    .option('--force', 'Replace the destination when it already exists')
    .option('--list', 'List available backups instead of creating one')
    .action(async (options: BackupCommandOptions) => {
      try {
        const result = await executeBackup(options);
        console.log(result.output);
      } catch (error) {
        printBackupError(error);
        process.exitCode = 1;
      }
    });
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('Restore the database from a backup file (SQLite keeps a pre-restore safety copy)')
    .argument('<file>', 'Backup file to restore (see `netpro backup --list`)')
    .action(async (file: string) => {
      try {
        const result = await executeRestore(file);
        console.log(result.output);
      } catch (error) {
        printBackupError(error);
        process.exitCode = 1;
      }
    });
}
