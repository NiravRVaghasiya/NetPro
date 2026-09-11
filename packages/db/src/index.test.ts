import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from './schema.sqlite';
import { closeConn, createDb } from './index';

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('packages/db schema', () => {
  it('exports all fifteen tables including Auth.js adapter tables', () => {
    const tableNames = [
      'contacts', 'interactions', 'edges', 'enrichments', 'campaigns',
      'campaignRecipients', 'searchIndex', 'profileViews', 'followUps', 'activityLog',
      'users', 'accounts', 'sessions', 'verificationTokens', 'profileCards',
    ];
    for (const name of tableNames) {
      expect(schema).toHaveProperty(name);
    }
  });

  it('wires an in-memory SQLite database without throwing', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    expect(db).toBeDefined();
  });

  it('stores the SQLite database file mode 0600 and tightens existing files (phase 23)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-dbmode-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NETPRO_HOME: dir,
        DB_DIALECT: 'sqlite',
        DB_PATH: join(dir, 'netpro.db'),
      };
      delete env.DATABASE_URL;
      const conn = createDb(env);
      try {
        expect(statSync(join(dir, 'netpro.db')).mode & 0o777).toBe(0o600);
      } finally {
        await closeConn(conn);
      }
      // A pre-hardening database (world-readable) tightens on next open.
      chmodSync(join(dir, 'netpro.db'), 0o644);
      const reopened = createDb(env);
      try {
        expect(statSync(join(dir, 'netpro.db')).mode & 0o777).toBe(0o600);
      } finally {
        await closeConn(reopened);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
