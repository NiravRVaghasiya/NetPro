vi.mock('@/lib/authz', () => ({ requireMembership: async () => ({ workspaceId: 'default', userId: 'test-user', role: 'member' }) }));
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';

vi.mock('@/lib/db', () => {
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
    CREATE TABLE enrichments (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, provider TEXT NOT NULL,
      data_type TEXT NOT NULL, raw_payload TEXT, confidence REAL,
      fetched_at TEXT NOT NULL, expires_at TEXT, stale INTEGER DEFAULT 0,
      workspace_id TEXT DEFAULT 'default'
    );
  `);
  db.insert(schema.contacts).values({
    id: 'contact-1', fullName: 'Jane Doe', company: 'Stripe', source: 'linkedin_csv',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  return { conn: { dialect: 'sqlite', db, schema } };
});

const { POST } = await import('./route');

describe('POST /api/enrich', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports zero enrichments when no provider env vars are set', async () => {
    const response = await POST(new Request('http://localhost/api/enrich', {
      method: 'POST',
      body: JSON.stringify({ all: true }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enriched).toBe(0);
  });

  it('returns 400 when neither contactId nor all is provided', async () => {
    const response = await POST(new Request('http://localhost/api/enrich', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(400);
  });
});
