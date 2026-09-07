import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
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

    expect(summary).toMatchObject({ imported: 1, merged: 0, errors: [] });
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

    expect(secondSummary).toMatchObject({ imported: 0, merged: 1, errors: [] });
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

  // ─── Phase 3: connection-date persistence ────────────────────────────────

  it('persists the Connected On date as createdAt and lastInteraction', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    await runImport(csv, conn);

    const rows = await conn.db.select().from(conn.schema.contacts);
    expect(rows[0]!.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(rows[0]!.lastInteraction).toBe('2024-01-01T00:00:00.000Z');
  });

  it('falls back to import time when Connected On is missing or unparsable', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,,',
      'John,Smith,john@example.com,Vercel,PM,not a date,',
    ].join('\n');

    const before = Date.now();
    await runImport(csv, conn);

    const rows = await conn.db.select().from(conn.schema.contacts);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.lastInteraction).toBeNull();
      expect(Date.parse(row.createdAt)).toBeGreaterThanOrEqual(before);
    }
  });

  it('backfills lastInteraction on merge when the existing row has none, without touching createdAt', async () => {
    const first = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,,',
    ].join('\n');
    const second = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    await runImport(first, conn);
    const [before] = await conn.db.select().from(conn.schema.contacts);
    const createdAtBefore = before!.createdAt;

    const summary = await runImport(second, conn);
    expect(summary).toMatchObject({ imported: 0, merged: 1, errors: [] });

    const [row] = await conn.db.select().from(conn.schema.contacts);
    expect(row!.createdAt).toBe(createdAtBefore);
    expect(row!.lastInteraction).toBe('2024-01-01T00:00:00.000Z');
  });

  it('never overwrites an existing lastInteraction on re-import', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');

    await runImport(csv, conn);
    // Simulate a newer interaction recorded after import.
    const [row] = await conn.db.select().from(conn.schema.contacts);
    await conn.db.update(conn.schema.contacts)
      .set({ lastInteraction: '2026-06-01T00:00:00.000Z' })
      .where(eq(conn.schema.contacts.id, row!.id));

    await runImport(csv, conn);

    const [after] = await conn.db.select().from(conn.schema.contacts);
    expect(after!.lastInteraction).toBe('2026-06-01T00:00:00.000Z');
    expect(after!.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });
});
