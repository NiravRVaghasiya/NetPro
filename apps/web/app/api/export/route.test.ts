import { describe, it, expect, vi } from 'vitest';
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
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  db.insert(schema.contacts).values({
    id: 'contact-1', fullName: 'Jane Doe', email: 'jane@example.com', company: 'Stripe',
    source: 'linkedin_csv', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  return { conn: { dialect: 'sqlite', db, schema } };
});

const { GET } = await import('./route');

describe('GET /api/export', () => {
  it('returns a CSV attachment', async () => {
    const response = await GET(new Request('http://localhost/api/export?format=csv'));
    const text = await response.text();

    expect(response.headers.get('Content-Type')).toBe('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(text).toContain('Jane Doe');
  });

  it('rejects an unsupported format', async () => {
    const response = await GET(new Request('http://localhost/api/export?format=json'));
    expect(response.status).toBe(400);
  });
});
