import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@netpro/db/src/schema.sqlite';
import { runImport } from './pipeline';
import type { SqliteConn } from '@netpro/db';

function createTestConn(): SqliteConn {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  // Create tables directly (no migration files exist yet in this phase — see Note below)
  sqlite.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      email_verified INTEGER DEFAULT 0,
      phone TEXT,
      avatar_url TEXT,
      headline TEXT,
      company TEXT,
      company_domain TEXT,
      role TEXT,
      seniority TEXT,
      department TEXT,
      industry TEXT,
      location TEXT,
      country TEXT,
      timezone TEXT,
      linkedin_url TEXT,
      github_url TEXT,
      twitter_url TEXT,
      website_url TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      tags TEXT,
      custom_fields TEXT,
      notes TEXT,
      relationship_score REAL DEFAULT 0,
      last_interaction TEXT,
      interaction_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  return { dialect: 'sqlite', db, schema };
}

describe('runImport', () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
  });

  it('imports new contacts', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    const summary = await runImport(csv, conn);

    expect(summary).toEqual({ imported: 1, merged: 0, errors: [] });
    const rows = await conn.db.select().from(conn.schema.contacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: 'Jane Doe', email: 'jane@example.com', company: 'Stripe', source: 'linkedin_csv' });
  });

  it('merges on re-import by email match', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    await runImport(csv, conn);
    const secondSummary = await runImport(csv, conn);

    expect(secondSummary).toEqual({ imported: 0, merged: 1, errors: [] });
    const rows = await conn.db.select().from(conn.schema.contacts);
    expect(rows).toHaveLength(1);
  });

  it('reports a row-level error without aborting the whole import', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      ',,,,,,',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    const summary = await runImport(csv, conn);

    expect(summary.imported).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.reason).toMatch(/missing name/);
  });
});
