import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';
import { executeEnrich } from './enrich';
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
  db.insert(schema.contacts).values({
    id: 'contact-1', fullName: 'Jane Doe', company: 'Stripe', source: 'linkedin_csv',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  return { dialect: 'sqlite', db, schema };
}

describe('executeEnrich', () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports zero enrichments when no API keys are configured', async () => {
    // No Keychain mock needed: apps/cli's real Keychain reads from an
    // encrypted-file store that starts empty in a fresh test environment,
    // so Keychain.get() naturally resolves to null for all three providers.
    const output = await executeEnrich({ source: 'all' }, conn);
    expect(output).toContain('Enriched 0 of 1 contacts');
    expect(output).toContain('no API key configured');
  });

  it('rejects an unknown --source value', async () => {
    await expect(executeEnrich({ source: 'bogus' }, conn)).rejects.toThrow(/Unknown source/);
  });
});
