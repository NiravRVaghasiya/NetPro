import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT, skills TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      workspace_id TEXT DEFAULT 'default', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
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
  let tempHome: string;

  beforeEach(() => {
    conn = createTestConn();
    // Isolate the real Keychain's encrypted-file store (~/.netpro/credentials.enc)
    // so a machine that already has enrichment keys configured cannot leak real
    // keys into this test (or make it perform live network calls).
    tempHome = mkdtempSync(join(tmpdir(), 'netpro-enrich-test-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports zero enrichments when no API keys are configured', async () => {
    const output = await executeEnrich({ source: 'all' }, conn);
    expect(output).toContain('Enriched 0 of 1 contacts');
    expect(output).toContain('no API key configured');
  });

  it('rejects an unknown --source value', async () => {
    await expect(executeEnrich({ source: 'bogus' }, conn)).rejects.toThrow(/Unknown source/);
  });
});
