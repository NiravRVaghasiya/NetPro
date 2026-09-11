import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { executeMigrate, migrationHint } from './migrate';

describe('netpro migrate', () => {
  it('reports an already-migrated database without applying anything', async () => {
    // createTestSqliteConn() runs the committed migrations, so this is the
    // steady state a deploy step sees on a redeploy with no schema change.
    const { conn, sqlite } = createTestSqliteConn();
    try {
      const result = await executeMigrate({}, conn);
      expect(result.dialect).toBe('sqlite');
      expect(result.changed).toBe(0);
      expect(result.applied).toBe(result.total);
      expect(result.output).toMatch(/already up to date/);
    } finally {
      sqlite.close();
    }
  });

  it('--status never mutates the database', async () => {
    const { conn, sqlite } = createTestSqliteConn();
    try {
      const before = sqlite
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .get() as { n: number };
      const result = await executeMigrate({ status: true }, conn);
      const after = sqlite
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .get() as { n: number };

      expect(after.n).toBe(before.n);
      expect(result.changed).toBe(0);
      expect(result.output).toContain(`Applied:  ${before.n}/${result.total}`);
      expect(result.output).toContain('Pending:  0');
    } finally {
      sqlite.close();
    }
  });

  it('applies pending migrations to an empty database and counts them', async () => {
    // A fresh connection with no migrations table at all — a first deploy.
    const Database = (await import('better-sqlite3')).default;
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('@netpro/db/src/schema.sqlite');
    const sqlite = new Database(':memory:');
    try {
      const conn = {
        dialect: 'sqlite' as const,
        db: drizzle(sqlite, { schema }),
        schema,
      };
      const result = await executeMigrate({}, conn);
      expect(result.changed).toBeGreaterThan(0);
      expect(result.applied).toBe(result.total);
      expect(result.output).toMatch(/Applied \d+ migrations?/);
      // The schema really exists afterwards, not just a journal row.
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM contacts').get()
      ).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['DATABASE_URL is required when DB_DIALECT=postgresql', /DB_DIALECT=postgresql/],
    ['self signed certificate in certificate chain', /sslmode=require/],
    ['The server does not support SSL connections', /sslmode=disable/],
    ['connect ECONNREFUSED 10.0.0.1:5432', /unreachable/],
    ['canceling statement due to lock timeout', /another deploy/],
  ])('turns %j into actionable advice', (message, expected) => {
    expect(migrationHint(message)).toMatch(expected);
  });

  it('offers no hint for an unrecognised failure rather than guessing', () => {
    expect(migrationHint('syntax error at or near "SELCT"')).toBeNull();
  });

  it('takes a pre-migration backup of a file database with pending migrations (phase 22)', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('@netpro/db/src/schema.sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'netpro-migrate-backup-'));
    try {
      const sqlite = new Database(join(dir, 'live.db'));
      const conn = {
        dialect: 'sqlite' as const,
        db: drizzle(sqlite, { schema }),
        schema,
      };
      const env = { NETPRO_BACKUP_DIR: join(dir, 'backups') } as NodeJS.ProcessEnv;
      const result = await executeMigrate({}, conn, env);
      try {
        expect(result.changed).toBeGreaterThan(0);
        expect(result.backupPath).not.toBeNull();
        expect(result.backupPath!).toMatch(/pre-migrate-.*\.db$/);
        expect(result.output).toMatch(/Pre-migration backup:/);
        expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the backup for --no-backup, --status, no-op runs, and :memory: (phase 22)', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('@netpro/db/src/schema.sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'netpro-migrate-nobackup-'));
    try {
      const env = { NETPRO_BACKUP_DIR: join(dir, 'backups') } as NodeJS.ProcessEnv;

      // --status never backs up.
      const statusDb = new Database(join(dir, 'status.db'));
      try {
        const statusConn = { dialect: 'sqlite' as const, db: drizzle(statusDb, { schema }), schema };
        const status = await executeMigrate({ status: true }, statusConn, env);
        expect(status.backupPath).toBeNull();
      } finally {
        statusDb.close();
      }

      // --no-backup migrates with no safety copy.
      const plainDb = new Database(join(dir, 'plain.db'));
      try {
        const plainConn = { dialect: 'sqlite' as const, db: drizzle(plainDb, { schema }), schema };
        const plain = await executeMigrate({ backup: false }, plainConn, env);
        expect(plain.changed).toBeGreaterThan(0);
        expect(plain.backupPath).toBeNull();
        // A second run is a no-op — and a no-op takes no backup either.
        const noop = await executeMigrate({}, plainConn, env);
        expect(noop.changed).toBe(0);
        expect(noop.backupPath).toBeNull();
      } finally {
        plainDb.close();
      }

      // :memory: has no file to preserve.
      const mem = new Database(':memory:');
      try {
        const memConn = { dialect: 'sqlite' as const, db: drizzle(mem, { schema }), schema };
        const result = await executeMigrate({}, memConn, env);
        expect(result.changed).toBeGreaterThan(0);
        expect(result.backupPath).toBeNull();
      } finally {
        mem.close();
      }

      expect(readdirSync(dir).filter((n) => n === 'backups')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
