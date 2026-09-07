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
  return { conn: { dialect: 'sqlite', db, schema } };
});

const { POST } = await import('./route');

describe('POST /api/import', () => {
  it('imports an uploaded CSV and returns a summary', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');
    const formData = new FormData();
    formData.append('file', new File([csv], 'connections.csv', { type: 'text/csv' }));

    const response = await POST(new Request('http://localhost/api/import', { method: 'POST', body: formData }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ imported: 1, merged: 0, errors: [] });
  });

  it('returns 400 when no file is provided', async () => {
    const formData = new FormData();
    const response = await POST(new Request('http://localhost/api/import', { method: 'POST', body: formData }));

    expect(response.status).toBe(400);
  });
});
