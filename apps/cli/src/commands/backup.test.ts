import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFailureHint, executeBackup, executeRestore } from './backup';

function scratchEnv(): { env: NodeJS.ProcessEnv; home: string; dbPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'netpro-cli-backup-'));
  const dbPath = join(home, 'netpro.db');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NETPRO_HOME: home,
    DB_DIALECT: 'sqlite',
    DB_PATH: dbPath,
  };
  delete env.DATABASE_URL;
  return { env, home, dbPath };
}

/** Create + migrate the scratch database with one contact. */
async function seedDb(env: NodeJS.ProcessEnv, dbPath: string, contactId = 'c1'): Promise<void> {
  const { createDb, closeConn, runMigrations } = await import('@netpro/db');
  const conn = createDb(env);
  try {
    await runMigrations(conn, { force: true });
    if (conn.dialect !== 'sqlite') throw new Error('expected sqlite in test');
    const client = (conn.db as unknown as { $client: { prepare: (sql: string) => { run: (...a: string[]) => void } } }).$client;
    client
      .prepare(
        'INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)'
      )
      .run(contactId, 'Ada Lovelace', 'test', '2026-01-01', '2026-01-01');
  } finally {
    await closeConn(conn);
  }
  void dbPath;
}

describe('netpro backup', () => {
  it('--list reports an empty backup directory, then the backup it holds', async () => {
    const { env, home } = scratchEnv();
    try {
      const empty = await executeBackup({ list: true }, env);
      expect(empty.dialect).toBeNull();
      expect(empty.listed).toEqual([]);
      expect(empty.output).toMatch(/No backups in .*backups/);

      await seedDb(env, join(home, 'netpro.db'));
      const created = await executeBackup({}, env, { now: new Date('2026-09-11T08:05:09.000Z') });
      expect(created.path).toBe(join(home, 'backups', 'netpro-20260911-080509.db'));

      const listed = await executeBackup({ list: true }, env);
      expect(listed.listed?.map((e) => e.name)).toEqual(['netpro-20260911-080509.db']);
      expect(listed.output).toMatch(/netpro restore/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('snapshots SQLite mode 0600 without migrating as a side effect', async () => {
    const { env, home, dbPath } = scratchEnv();
    try {
      await seedDb(env, dbPath);
      const before = statSync(dbPath).mtimeMs;
      const result = await executeBackup({}, env);
      expect(result.dialect).toBe('sqlite');
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.output).toMatch(/Backed up SQLite/);
      expect(statSync(result.path!).mode & 0o777).toBe(0o600);
      // The live file is untouched — a backup reads, never writes.
      expect(statSync(dbPath).mtimeMs).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to back up a database that was never created', async () => {
    const { env, home } = scratchEnv();
    try {
      await expect(executeBackup({}, env)).rejects.toThrow(/No SQLite database/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--output honours --force for overwrites', async () => {
    const { env, home, dbPath } = scratchEnv();
    try {
      await seedDb(env, dbPath);
      const out = join(home, 'custom.db');
      const first = await executeBackup({ output: out }, env);
      expect(first.path).toBe(out);
      await expect(executeBackup({ output: out }, env)).rejects.toThrow(/Refusing to overwrite/);
      const forced = await executeBackup({ output: out, force: true }, env);
      expect(forced.path).toBe(out);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('backs up PostgreSQL through pg_dump (injected runner)', async () => {
    const { home } = scratchEnv();
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NETPRO_HOME: home,
        DB_DIALECT: 'postgresql',
        DATABASE_URL: 'postgresql://u@h/db',
      };
      const calls: Array<{ bin: string; args: string[] }> = [];
      const result = await executeBackup({}, env, {
        now: new Date('2026-09-11T08:05:09.000Z'),
        run: async (bin, args) => {
          calls.push({ bin, args });
          writeFileSync(join(home, 'backups', 'netpro-20260911-080509.dump'), 'PGDMPfake');
          return { stdout: '', stderr: '' };
        },
      });
      expect(result.dialect).toBe('postgresql');
      expect(calls.map((c) => c.bin)).toEqual(['pg_dump']);
      expect(statSync(result.path!).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('netpro restore', () => {
  it('round-trips: backup → change live → restore → original content + safety copy', async () => {
    const { env, home, dbPath } = scratchEnv();
    try {
      await seedDb(env, dbPath, 'original');
      const snap = await executeBackup({}, env);

      // Diverge the live database after the snapshot.
      const { createDb, closeConn } = await import('@netpro/db');
      const conn = createDb(env);
      try {
        if (conn.dialect !== 'sqlite') throw new Error('expected sqlite in test');
        const client = (conn.db as unknown as { $client: { prepare: (sql: string) => { run: (...a: string[]) => void } } }).$client;
        client.prepare('DELETE FROM contacts').run();
        client
          .prepare(
            'INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)'
          )
          .run('diverged', 'Diverged', 'test', '2026-01-01', '2026-01-01');
      } finally {
        await closeConn(conn);
      }

      const restored = await executeRestore(snap.path!, env, {
        now: new Date('2026-09-11T09:00:00.000Z'),
      });
      expect(restored.dialect).toBe('sqlite');
      expect(restored.output).toMatch(/15\/15 migrations applied/);
      expect(restored.safetyBackup).toBe(join(home, 'backups', 'pre-restore-20260911-090000.db'));

      const Database = (await import('better-sqlite3')).default;
      const checkLive = new Database(dbPath, { readonly: true });
      try {
        expect(checkLive.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'original' }]);
      } finally {
        checkLive.close();
      }
      const checkSafety = new Database(restored.safetyBackup!, { readonly: true });
      try {
        expect(checkSafety.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'diverged' }]);
      } finally {
        checkSafety.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an invalid backup and leaves the live database untouched', async () => {
    const { env, home, dbPath } = scratchEnv();
    try {
      await seedDb(env, dbPath, 'keepme');
      const fake = join(home, 'note.csv');
      writeFileSync(fake, 'full_name\nAda\n');
      await expect(executeRestore(fake, env)).rejects.toThrow(/Not a SQLite/);

      const Database = (await import('better-sqlite3')).default;
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'keepme' }]);
      } finally {
        check.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('restores PostgreSQL through pg_restore for custom archives', async () => {
    const { home } = scratchEnv();
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NETPRO_HOME: home,
        DB_DIALECT: 'postgresql',
        DATABASE_URL: 'postgresql://u@h/db',
      };
      const dump = join(home, 'b.dump');
      writeFileSync(dump, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(10)]));
      const calls: Array<{ bin: string }> = [];
      const result = await executeRestore(dump, env, {
        run: async (bin) => {
          calls.push({ bin });
          return { stdout: '', stderr: '' };
        },
      });
      expect(result.dialect).toBe('postgresql');
      expect(result.safetyBackup).toBeNull();
      expect(calls.map((c) => c.bin)).toEqual(['pg_restore']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('backupFailureHint', () => {
  it.each([
    ['DATABASE_URL is required when DB_DIALECT=postgresql', /DB_DIALECT=postgresql/],
    ['Cannot back up PostgreSQL: `pg_dump` was not found.', /postgresql-client/],
    ['connect ECONNREFUSED 10.0.0.1:5432', /unreachable/],
    ['No SQLite database at /tmp/x/netpro.db', /netpro init/],
  ])('turns %j into actionable advice', (message, expected) => {
    expect(backupFailureHint(message)).toMatch(expected);
  });

  it('offers no hint for an unrecognised failure rather than guessing', () => {
    expect(backupFailureHint('syntax error at or near "SELCT"')).toBeNull();
  });
});
