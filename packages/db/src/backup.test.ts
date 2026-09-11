import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.sqlite';
import {
  BackupError,
  assertValidSqliteBackup,
  backupDir,
  backupPostgres,
  backupSqlite,
  defaultBackupFilename,
  ensureBackupDir,
  listBackups,
  pgBackupKind,
  pgDumpArgs,
  pgRestoreArgs,
  psqlRestoreArgs,
  restorePostgres,
  restoreSqlite,
  sqliteFileOf,
} from './backup';
import type { SqliteConn } from './index';

const folder = fileURLToPath(new URL('../migrations/sqlite', import.meta.url));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'netpro-backup-'));
}

/** A migrated on-disk database with one contact, returned open. */
function migratedFileDb(path: string): { conn: SqliteConn; sqlite: Database.Database } {
  const sqlite = new Database(path);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: folder });
  sqlite
    .prepare(
      'INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)'
    )
    .run('c1', 'Ada Lovelace', 'test', '2026-01-01', '2026-01-01');
  return { conn: { dialect: 'sqlite', db, schema }, sqlite };
}

describe('backup locations', () => {
  it('defaults to <home>/backups', () => {
    expect(backupDir({ NETPRO_HOME: '/tmp/nphome' } as NodeJS.ProcessEnv)).toBe(
      join('/tmp/nphome', 'backups')
    );
  });

  it('honours NETPRO_BACKUP_DIR, expanding ~', () => {
    expect(
      backupDir({ NETPRO_BACKUP_DIR: '~/my-backups' } as NodeJS.ProcessEnv)
    ).toBe(join(homedir(), 'my-backups'));
    expect(backupDir({ NETPRO_BACKUP_DIR: '/mnt/bk' } as NodeJS.ProcessEnv)).toBe('/mnt/bk');
  });

  it('ensureBackupDir creates the directory idempotently', () => {
    const dir = scratch();
    try {
      const env = { NETPRO_BACKUP_DIR: join(dir, 'bk') } as NodeJS.ProcessEnv;
      expect(ensureBackupDir(env)).toBe(join(dir, 'bk'));
      expect(ensureBackupDir(env)).toBe(join(dir, 'bk'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultBackupFilename is UTC, filename-safe, and dialect-typed', () => {
    const now = new Date('2026-09-11T08:05:09.000Z');
    expect(defaultBackupFilename('sqlite', now)).toBe('netpro-20260911-080509.db');
    expect(defaultBackupFilename('postgresql', now)).toBe('netpro-20260911-080509.dump');
    expect(defaultBackupFilename('sqlite', now, 'pre-restore')).toBe(
      'pre-restore-20260911-080509.db'
    );
  });
});

describe('sqliteFileOf', () => {
  it('returns the file path, and null for :memory:', () => {
    const dir = scratch();
    try {
      const { conn, sqlite } = migratedFileDb(join(dir, 'live.db'));
      try {
        expect(sqliteFileOf(conn)).toBe(join(dir, 'live.db'));
      } finally {
        sqlite.close();
      }
      const mem = new Database(':memory:');
      try {
        const conn: SqliteConn = { dialect: 'sqlite', db: drizzle(mem, { schema }), schema };
        expect(sqliteFileOf(conn)).toBeNull();
      } finally {
        mem.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backupSqlite', () => {
  it('writes a mode-0600 snapshot whose content matches the live database', async () => {
    const dir = scratch();
    try {
      const { conn, sqlite } = migratedFileDb(join(dir, 'live.db'));
      try {
        const dest = join(dir, 'bk', 'snap.db');
        const result = await backupSqlite(conn, dest);
        expect(result).toMatchObject({ path: dest, dialect: 'sqlite' });
        expect(result.bytes).toBeGreaterThan(0);
        expect(statSync(dest).mode & 0o777).toBe(0o600);

        const check = new Database(dest, { readonly: true });
        try {
          expect(check.prepare('SELECT full_name FROM contacts').get()).toEqual({
            full_name: 'Ada Lovelace',
          });
          expect(check.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
            n: (sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n,
          });
        } finally {
          check.close();
        }
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite without --force and overwrites with it', async () => {
    const dir = scratch();
    try {
      const { conn, sqlite } = migratedFileDb(join(dir, 'live.db'));
      try {
        const dest = join(dir, 'snap.db');
        await backupSqlite(conn, dest);
        await expect(backupSqlite(conn, dest)).rejects.toThrow(BackupError);
        await expect(backupSqlite(conn, dest)).rejects.toThrow(/Refusing to overwrite/);
        const again = await backupSqlite(conn, dest, { overwrite: true });
        expect(again.path).toBe(dest);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertValidSqliteBackup', () => {
  it('accepts a migrated database and rejects everything else', () => {
    const dir = scratch();
    try {
      const { sqlite } = migratedFileDb(join(dir, 'good.db'));
      sqlite.close();
      expect(assertValidSqliteBackup(join(dir, 'good.db')).bytes).toBeGreaterThan(0);

      expect(() => assertValidSqliteBackup(join(dir, 'missing.db'))).toThrow(/No backup file/);

      writeFileSync(join(dir, 'note.csv'), 'full_name\nAda\n');
      expect(() => assertValidSqliteBackup(join(dir, 'note.csv'))).toThrow(/Not a SQLite/);

      const empty = new Database(join(dir, 'empty.db'));
      empty.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');
      empty.close();
      expect(() => assertValidSqliteBackup(join(dir, 'empty.db'))).toThrow(
        /no migration journal/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restoreSqlite', () => {
  it('restores over a live database, keeping a pre-restore safety copy', async () => {
    const dir = scratch();
    try {
      const live = join(dir, 'live.db');
      const first = migratedFileDb(live);
      first.sqlite.close();

      // The backup holds different content (an extra contact).
      const backup = join(dir, 'snap.db');
      const src = new Database(backup);
      try {
        const db = drizzle(src, { schema });
        migrate(db, { migrationsFolder: folder });
        src
          .prepare(
            'INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)'
          )
          .run('restored', 'Grace Hopper', 'test', '2026-01-01', '2026-01-01');
      } finally {
        src.close();
      }
      // A stale WAL sibling from the previous image must not survive.
      writeFileSync(`${live}-wal`, 'stale');
      writeFileSync(`${live}-shm`, 'stale');

      const env = { NETPRO_BACKUP_DIR: join(dir, 'bk') } as NodeJS.ProcessEnv;
      const result = await restoreSqlite(live, backup, {
        env,
        now: new Date('2026-09-11T08:05:09.000Z'),
      });
      expect(result.restored).toBe(live);
      expect(result.safetyBackup).toBe(join(dir, 'bk', 'pre-restore-20260911-080509.db'));

      // Live now holds the backup's content; the safety copy holds the old.
      const checkLive = new Database(live, { readonly: true });
      try {
        expect(checkLive.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'restored' }]);
      } finally {
        checkLive.close();
      }
      const checkSafety = new Database(result.safetyBackup!, { readonly: true });
      try {
        expect(checkSafety.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'c1' }]);
      } finally {
        checkSafety.close();
      }
      expect(statSync(live).mode & 0o777).toBe(0o600);
      expect(statSync(result.safetyBackup!).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores onto a missing live path with no safety copy', async () => {
    const dir = scratch();
    try {
      const backup = join(dir, 'snap.db');
      const { sqlite } = migratedFileDb(backup);
      sqlite.close();
      const result = await restoreSqlite(join(dir, 'fresh.db'), backup, {
        env: { NETPRO_BACKUP_DIR: join(dir, 'bk') } as NodeJS.ProcessEnv,
      });
      expect(result.safetyBackup).toBeNull();
      const check = new Database(join(dir, 'fresh.db'), { readonly: true });
      try {
        expect(check.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'c1' }]);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a backup that is the live file, and refuses invalid backups', async () => {
    const dir = scratch();
    try {
      const live = join(dir, 'live.db');
      const { sqlite } = migratedFileDb(live);
      sqlite.close();
      await expect(
        restoreSqlite(live, live, { env: {} as NodeJS.ProcessEnv })
      ).rejects.toThrow(/same file/);

      writeFileSync(join(dir, 'note.csv'), 'full_name\nAda\n');
      await expect(
        restoreSqlite(live, join(dir, 'note.csv'), { env: {} as NodeJS.ProcessEnv })
      ).rejects.toThrow(BackupError);
      // The live database is untouched by both refusals.
      const check = new Database(live, { readonly: true });
      try {
        expect(check.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'c1' }]);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PostgreSQL tooling', () => {
  it('builds the exact pg_dump / pg_restore / psql invocations', () => {
    expect(pgDumpArgs('postgresql://u@h/db', '/tmp/b.dump')).toEqual([
      '--dbname=postgresql://u@h/db',
      '--format=custom',
      '--file=/tmp/b.dump',
    ]);
    expect(pgRestoreArgs('postgresql://u@h/db', '/tmp/b.dump')).toEqual([
      '--dbname=postgresql://u@h/db',
      '--clean',
      '--if-exists',
      '/tmp/b.dump',
    ]);
    expect(psqlRestoreArgs('postgresql://u@h/db', '/tmp/b.sql')).toEqual([
      '--dbname=postgresql://u@h/db',
      '--file=/tmp/b.sql',
      '--single-transaction',
      '--set=ON_ERROR_STOP=1',
    ]);
  });

  it('sniffs custom vs plain-SQL backups instead of trusting the extension', () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'a.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(10)]));
      writeFileSync(join(dir, 'b.dump'), '-- plain sql dump\nSELECT 1;\n');
      expect(pgBackupKind(join(dir, 'a.dump'))).toBe('custom');
      expect(pgBackupKind(join(dir, 'b.dump'))).toBe('sql');
      expect(() => pgBackupKind(join(dir, 'missing.dump'))).toThrow(/No backup file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backupPostgres shells to pg_dump and stores mode 0600', async () => {
    const dir = scratch();
    try {
      const dest = join(dir, 'b.dump');
      const calls: Array<{ bin: string; args: string[] }> = [];
      const result = await backupPostgres('postgresql://u@h/db', dest, {
        run: async (bin, args) => {
          calls.push({ bin, args });
          writeFileSync(dest, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(10)]));
          return { stdout: '', stderr: '' };
        },
      });
      expect(calls).toEqual([
        { bin: 'pg_dump', args: pgDumpArgs('postgresql://u@h/db', dest) },
      ]);
      expect(result).toMatchObject({ path: dest, dialect: 'postgresql' });
      expect(statSync(dest).mode & 0o777).toBe(0o600);

      await expect(
        backupPostgres('postgresql://u@h/db', dest, { run: async () => ({ stdout: '', stderr: '' }) })
      ).rejects.toThrow(/Refusing to overwrite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a missing pg_dump into installation advice, not a stack trace', async () => {
    const dir = scratch();
    try {
      let err: BackupError | null = null;
      try {
        await backupPostgres('postgresql://u@h/db', join(dir, 'b.dump'), {
          run: async () => {
            throw Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });
          },
        });
        expect.unreachable('expected backupPostgres to throw');
      } catch (e) {
        err = e as BackupError;
      }
      expect(err).toBeInstanceOf(BackupError);
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/pg_dump.*not found/);
      expect(err?.hint).toMatch(/postgresql-client/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces pg_dump stderr when the dump itself fails', async () => {
    const dir = scratch();
    try {
      let err: BackupError | null = null;
      try {
        await backupPostgres('postgresql://u@h/db', join(dir, 'b.dump'), {
          run: async () => {
            throw Object.assign(new Error('exit 1'), { stderr: 'pg_dump: connection refused\n' });
          },
        });
        expect.unreachable('expected backupPostgres to throw');
      } catch (e) {
        err = e as BackupError;
      }
      expect(err?.message).toMatch(/connection refused/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restorePostgres routes custom archives to pg_restore and SQL to psql', async () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'a.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(10)]));
      writeFileSync(join(dir, 'b.sql'), '-- plain sql dump\nSELECT 1;\n');
      const calls: Array<{ bin: string; args: string[] }> = [];
      const run = async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        return { stdout: '', stderr: '' };
      };
      const custom = await restorePostgres('postgresql://u@h/db', join(dir, 'a.dump'), { run });
      expect(custom.kind).toBe('custom');
      const sql = await restorePostgres('postgresql://u@h/db', join(dir, 'b.sql'), { run });
      expect(sql.kind).toBe('sql');
      expect(calls.map((c) => c.bin)).toEqual(['pg_restore', 'psql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listBackups', () => {
  it('lists newest-first, skips dotfiles and directories, tolerates a missing dir', () => {
    const dir = scratch();
    try {
      expect(listBackups(join(dir, 'nope'))).toEqual([]);
      const bk = join(dir, 'bk');
      mkdirSync(bk, { recursive: true });
      mkdirSync(join(bk, 'subdir'));
      writeFileSync(join(bk, '.hidden'), 'x');
      writeFileSync(join(bk, 'old.db'), 'a');
      writeFileSync(join(bk, 'new.db'), 'bb');
      // Force distinct mtimes (filesystems with coarse granularity).
      const old = new Date('2026-09-10T00:00:00.000Z');
      const fresh = new Date('2026-09-11T00:00:00.000Z');
      chmodSync(join(bk, 'old.db'), 0o600);
      utimesSync(join(bk, 'old.db'), old, old);
      utimesSync(join(bk, 'new.db'), fresh, fresh);

      const entries = listBackups(bk);
      expect(entries.map((e) => e.name)).toEqual(['new.db', 'old.db']);
      expect(entries[0]).toMatchObject({ bytes: 2 });
      expect(readFileSync(entries[1]!.path, 'utf8')).toBe('a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
