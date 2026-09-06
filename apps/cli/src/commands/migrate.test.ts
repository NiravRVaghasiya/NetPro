import { describe, expect, it } from 'vitest';
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
});
