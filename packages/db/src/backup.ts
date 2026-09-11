// Local backup & restore (local-first Phase 22 — migration testing).
//
// Migrations protect existing users only when a bad one is recoverable.
// This module owns the recoverability half of that promise:
//
//   • SQLite (the local default): a `VACUUM INTO`-free copy via the SQLite
//     backup API (`better-sqlite3`'s `.backup()`), which reads a consistent
//     snapshot even while the database is open and compacts WAL frames into
//     the destination. The result is a self-contained `.db` file.
//   • PostgreSQL (self-hosted): the database-native tools, `pg_dump` (custom
//     format) and `pg_restore`/`psql`. NetPro shells out rather than
//     reimplementing a dump writer — a hand-rolled `SELECT *` exporter would
//     silently lose sequences, constraints, and extension state.
//
// Every backup lands in `<home>/backups/` (`NETPRO_BACKUP_DIR` overrides)
// with mode 0600: a backup is a full copy of the professional network and is
// protected exactly like the live database (Phase 23).
//
// This module imports only node builtins plus better-sqlite3, so the CLI's
// `backup`/`restore`/`migrate` commands bundle cleanly (see bundle.test.ts).

import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { SqliteConn } from './index';
import { expandHomePath, netproHome } from './local';

const execFileAsync = promisify(execFile);

export class BackupError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export type BackupDialect = 'sqlite' | 'postgresql';

// ── Locations ────────────────────────────────────────────────────────────

/**
 * Where timestamped backups live: `<home>/backups/`, or `NETPRO_BACKUP_DIR`
 * when the operator relocates it (portable installs, a mounted volume).
 */
export function backupDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NETPRO_BACKUP_DIR?.trim();
  if (override) return expandHomePath(override, env);
  return join(netproHome(env), 'backups');
}

/** Create the backup directory (idempotent). Returns the path. */
export function ensureBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = backupDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `netpro-20260911-080000.db` — UTC, filename-safe on every platform. */
export function defaultBackupFilename(
  dialect: BackupDialect,
  now: Date = new Date(),
  prefix = 'netpro'
): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const ext = dialect === 'sqlite' ? '.db' : '.dump';
  return `${prefix}-${stamp}${ext}`;
}

/**
 * The on-disk SQLite file behind a connection, or `null` for `:memory:` and
 * other non-file databases (which backup/restore skip by definition).
 */
export function sqliteFileOf(conn: SqliteConn): string | null {
  const client = (conn.db as unknown as { $client?: { name?: unknown } }).$client;
  const name = typeof client?.name === 'string' ? client.name : null;
  if (!name || name === ':memory:') return null;
  return name;
}

// ── SQLite ───────────────────────────────────────────────────────────────

export type BackupResult = {
  /** Absolute path of the backup file. */
  path: string;
  bytes: number;
  dialect: BackupDialect;
};

/**
 * Copy a live SQLite database to `destPath` via the SQLite backup API.
 *
 * Unlike a raw file copy this is safe while the database is open: the backup
 * API reads page-by-page under the database lock and folds WAL frames into
 * the destination, so the result never needs a `-wal` sibling to be valid.
 * Refuses to overwrite an existing file unless `overwrite` is set, and always
 * stores the result mode 0600.
 */
export async function backupSqlite(
  conn: SqliteConn,
  destPath: string,
  options: { overwrite?: boolean } = {}
): Promise<BackupResult> {
  const dest = resolve(destPath);
  if (existsSync(dest) && !options.overwrite) {
    throw new BackupError(
      `Refusing to overwrite the existing backup at ${dest}.`,
      'Pass --force to replace it, or choose another --output path.'
    );
  }
  mkdirSync(dirname(dest), { recursive: true });

  const client = (conn.db as unknown as { $client?: { backup?: unknown } }).$client;
  const backup = client?.backup;
  if (typeof backup !== 'function') {
    throw new BackupError('The SQLite connection does not expose a backup API.');
  }
  await (backup as (dest: string) => Promise<void>).call(client, dest);

  chmodSync(dest, 0o600);
  return { path: dest, bytes: statSync(dest).size, dialect: 'sqlite' };
}

/** First 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Refuse anything that is not plausibly a NetPro SQLite backup: it must exist,
 * carry the SQLite magic header, and contain a `__drizzle_migrations` table.
 * A restore built on this check cannot turn a CSV export or a truncated copy
 * into the live database.
 */
export function assertValidSqliteBackup(backupPath: string): { path: string; bytes: number } {
  const path = resolve(backupPath);
  if (!existsSync(path)) {
    throw new BackupError(
      `No backup file at ${path}.`,
      'List available backups with `netpro backup --list`.'
    );
  }
  const bytes = statSync(path).size;
  if (bytes < 100) {
    throw new BackupError(`Not a SQLite database: ${path} is only ${bytes} bytes.`);
  }
  const header = readFileSync(path).subarray(0, 16).toString('binary');
  if (header !== SQLITE_MAGIC) {
    throw new BackupError(
      `Not a SQLite database: ${path} has an unrecognised file header.`,
      'Restore the `.db` file `netpro backup` wrote — not a CSV export or a partial copy.'
    );
  }
  // Open read-only so validation itself can never modify the candidate.
  const readonly = new Database(path, { readonly: true });
  try {
    const row = readonly
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      )
      .get() as { name?: string } | undefined;
    if (!row) {
      throw new BackupError(
        `Not a NetPro database: ${path} has no migration journal.`,
        'Restore a backup `netpro backup` wrote for this installation.'
      );
    }
  } finally {
    readonly.close();
  }
  return { path, bytes };
}

export type RestoreSqliteResult = {
  /** The live database path that now holds the restored image. */
  restored: string;
  /** Safety copy of the pre-restore database, or null when none existed. */
  safetyBackup: string | null;
};

/**
 * Replace the live SQLite database with a validated backup.
 *
 * When a live database already exists it is first copied to
 * `<backups>/pre-restore-<stamp>.db` (mode 0600), so a restore is itself
 * recoverable — restoring the wrong file is one more restore away from
 * fixed. Stale `-wal`/`-shm` siblings of the previous image are removed:
 * they describe pages of the old file and must never be read against the new
 * one.
 *
 * Callers must NOT hold the live database open across this call, and the
 * server must be stopped first: replacing the file under a running
 * better-sqlite3 handle corrupts that process's view. The CLI refuses the
 * footgun it can see (backup == target) and documents the one it cannot.
 */
export async function restoreSqlite(
  livePath: string,
  backupPath: string,
  options: { env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<RestoreSqliteResult> {
  const live = resolve(livePath);
  const { path: valid } = assertValidSqliteBackup(backupPath);
  if (valid === live) {
    throw new BackupError(
      'The backup and the live database are the same file — nothing to restore.',
      'Pick a file from `netpro backup --list`.'
    );
  }
  mkdirSync(dirname(live), { recursive: true });

  let safetyBackup: string | null = null;
  if (existsSync(live)) {
    const env = options.env ?? process.env;
    ensureBackupDir(env);
    safetyBackup = join(
      backupDir(env),
      defaultBackupFilename('sqlite', options.now ?? new Date(), 'pre-restore')
    );
    copyFileSync(live, safetyBackup);
    chmodSync(safetyBackup, 0o600);
  }

  copyFileSync(valid, live);
  chmodSync(live, 0o600);
  // Siblings of the previous image (WAL mode): never valid for the new one.
  rmSync(`${live}-wal`, { force: true });
  rmSync(`${live}-shm`, { force: true });
  return { restored: live, safetyBackup };
}

// ── PostgreSQL (database-native tools) ───────────────────────────────────

export type ExecFn = (
  bin: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

/** `pg_dump --format=custom`: a compressed, `pg_restore`-able archive. */
export function pgDumpArgs(url: string, destPath: string): string[] {
  return [`--dbname=${url}`, '--format=custom', `--file=${destPath}`];
}

/** Plain-SQL dumps restore through `psql`, single-transaction and strict. */
export function psqlRestoreArgs(url: string, sqlPath: string): string[] {
  return [
    `--dbname=${url}`,
    `--file=${sqlPath}`,
    '--single-transaction',
    '--set=ON_ERROR_STOP=1',
  ];
}

/** Custom-format archives restore through `pg_restore --clean`. */
export function pgRestoreArgs(url: string, dumpPath: string): string[] {
  return [`--dbname=${url}`, '--clean', '--if-exists', dumpPath];
}

const PG_CUSTOM_MAGIC = 'PGDMP';

function missingBinaryHint(bin: string): string {
  return (
    `\`${bin}\` is not on PATH. Install the PostgreSQL client tools ` +
    `(\`postgresql-client\`, or \`brew install libpq\`), or dump from the container: ` +
    `\`docker compose exec -T db pg_dump -U netpro -d netpro > backup.sql\`.`
  );
}

async function runTool(
  run: ExecFn | undefined,
  bin: string,
  args: string[],
  what: string
): Promise<void> {
  const exec = run ?? execFileAsync;
  try {
    await exec(bin, args);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      throw new BackupError(`Cannot ${what}: \`${bin}\` was not found.`, missingBinaryHint(bin));
    }
    const stderr = (error as { stderr?: unknown })?.stderr;
    const detail = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new BackupError(`Cannot ${what}: \`${bin}\` failed${detail}`);
  }
}

/**
 * Dump a PostgreSQL database with `pg_dump --format=custom`.
 * `run` injects the process runner (tests); production shells out for real.
 */
export async function backupPostgres(
  url: string,
  destPath: string,
  options: { overwrite?: boolean; run?: ExecFn } = {}
): Promise<BackupResult> {
  const dest = resolve(destPath);
  if (existsSync(dest) && !options.overwrite) {
    throw new BackupError(
      `Refusing to overwrite the existing backup at ${dest}.`,
      'Pass --force to replace it, or choose another --output path.'
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  await runTool(options.run, 'pg_dump', pgDumpArgs(url, dest), 'back up PostgreSQL');
  chmodSync(dest, 0o600);
  return { path: dest, bytes: statSync(dest).size, dialect: 'postgresql' };
}

/** Custom (`pg_restore`) or plain-SQL (`psql`) — sniffed, never guessed. */
export function pgBackupKind(backupPath: string): 'custom' | 'sql' {
  const path = resolve(backupPath);
  if (!existsSync(path)) {
    throw new BackupError(
      `No backup file at ${path}.`,
      'List available backups with `netpro backup --list`.'
    );
  }
  const head = readFileSync(path).subarray(0, 5).toString('binary');
  return head === PG_CUSTOM_MAGIC ? 'custom' : 'sql';
}

/**
 * Restore a PostgreSQL backup: custom-format archives via `pg_restore
 * --clean --if-exists`, plain-SQL dumps via strict single-transaction `psql`.
 * There is no in-process safety copy for PostgreSQL — take a `netpro backup`
 * first when the live data matters (the CLI says so).
 */
export async function restorePostgres(
  url: string,
  backupPath: string,
  options: { run?: ExecFn } = {}
): Promise<{ restored: string; kind: 'custom' | 'sql' }> {
  const path = resolve(backupPath);
  const kind = pgBackupKind(path);
  if (kind === 'custom') {
    await runTool(options.run, 'pg_restore', pgRestoreArgs(url, path), 'restore PostgreSQL');
  } else {
    await runTool(options.run, 'psql', psqlRestoreArgs(url, path), 'restore PostgreSQL');
  }
  return { restored: url, kind };
}

// ── Inventory ────────────────────────────────────────────────────────────

export type BackupEntry = {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
};

/** Newest-first listing of a backup directory (missing dir → empty). */
export function listBackups(dir: string = backupDir()): BackupEntry[] {
  if (!existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      entries.push({ name: basename(path), path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}
