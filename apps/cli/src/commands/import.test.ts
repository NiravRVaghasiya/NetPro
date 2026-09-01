import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';
import { executeImport } from './import';
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
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  return { dialect: 'sqlite', db, schema };
}

describe('executeImport', () => {
  let conn: SqliteConn;
  let csvPath: string;

  beforeEach(() => {
    conn = createTestConn();
    const dir = mkdtempSync(join(tmpdir(), 'netpro-import-test-'));
    csvPath = join(dir, 'connections.csv');
    writeFileSync(
      csvPath,
      [
        'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
        'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
      ].join('\n')
    );
  });

  it('imports a CSV file and reports a summary', async () => {
    const output = await executeImport({ linkedin: csvPath }, conn);
    expect(output).toContain('Imported 1 contacts (0 merged)');
  });

  it('throws when no --linkedin path is given', async () => {
    await expect(executeImport({}, conn)).rejects.toThrow(/--linkedin/);
  });
});
