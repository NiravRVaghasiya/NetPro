import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';
import { executeExport } from './export';
import type { SqliteConn } from '@netpro/db';

function createTestConn(): SqliteConn {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
      email TEXT, email_verified INTEGER DEFAULT 0, phone TEXT, avatar_url TEXT,
      headline TEXT, company TEXT, company_domain TEXT, role TEXT, seniority TEXT,
      department TEXT, industry TEXT, location TEXT, country TEXT, timezone TEXT,
      linkedin_url TEXT, github_url TEXT, twitter_url TEXT, website_url TEXT,
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT, skills TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      workspace_id TEXT DEFAULT 'default', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  db.insert(schema.contacts).values({
    id: 'contact-1', fullName: 'Jane Doe', email: 'jane@example.com', company: 'Stripe',
    source: 'linkedin_csv', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  return { dialect: 'sqlite', db, schema };
}

describe('executeExport', () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
  });

  it('returns CSV to stdout when no --output is given', async () => {
    const { output, csv } = await executeExport({ format: 'csv' }, conn);
    expect(output).toBe(csv);
    expect(csv).toContain('Jane Doe');
  });

  it('rejects an unsupported format', async () => {
    await expect(executeExport({ format: 'json' }, conn)).rejects.toThrow(/not yet supported/);
  });

  it('writes --output files mode 0600 (phase 23)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-export-'));
    try {
      const output = join(dir, 'contacts.csv');
      const { csv } = await executeExport({ format: 'csv', output }, conn);
      expect(csv).toContain('Jane Doe');
      expect(statSync(output).mode & 0o777).toBe(0o600);
      // Overwriting a looser pre-existing file tightens it too.
      const { chmodSync } = await import('node:fs');
      chmodSync(output, 0o644);
      await executeExport({ format: 'csv', output }, conn);
      expect(statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
