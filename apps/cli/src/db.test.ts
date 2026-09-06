import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db';

describe('openDb', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'netpro-opendb-'));
    dbPath = join(tempDir, 'test.db');
    vi.stubEnv('DB_DIALECT', 'sqlite');
    vi.stubEnv('DB_PATH', dbPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a fresh database with the full migrated schema', async () => {
    const conn = await openDb();
    expect(conn.dialect).toBe('sqlite');

    const raw = new Database(dbPath);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('contacts');
    expect(names).toContain('interactions');
    expect(names).toContain('edges');
    expect(names).toContain('enrichments');
    expect(names).toContain('campaigns');
    expect(names).toContain('campaign_recipients');
    expect(names).toContain('search_index');
    expect(names).toContain('profile_views');
    expect(names).toContain('follow_ups');
    expect(names).toContain('activity_log');
    expect(names).toContain('user');
    expect(names).toContain('account');
    expect(names).toContain('session');
    expect(names).toContain('verificationToken');
    expect(names).toContain('__drizzle_migrations');
    raw.close();
  });

  it('is idempotent — reopening applies no new migrations', async () => {
    await openDb();
    const second = await openDb();
    expect(second.dialect).toBe('sqlite');

    const raw = new Database(dbPath);
    const contacts = raw.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number };
    expect(contacts.n).toBe(0);
    raw.close();
  });
});
