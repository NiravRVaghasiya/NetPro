import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@netpro/db/src/schema.sqlite';
import { EnrichmentPipeline } from './pipeline';
import type { SqliteConn } from '@netpro/db';
import type { EnrichmentProvider } from './types';

function createTestConn(): SqliteConn {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  // Full column set for `contacts`, matching schema.sqlite.ts — Drizzle's insert builder
  // references every schema-defined column (filling unspecified ones with NULL/defaults),
  // so a reduced DDL causes "table contacts has no column named ..." on the first insert.
  // Same fix as Task 2's import/pipeline.test.ts; `enrichments` DDL below already matches
  // the full schema so it's unaffected.
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
    CREATE TABLE enrichments (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, provider TEXT NOT NULL,
      data_type TEXT NOT NULL, raw_payload TEXT, confidence REAL,
      fetched_at TEXT NOT NULL, expires_at TEXT, stale INTEGER DEFAULT 0
    );
  `);
  return { dialect: 'sqlite', db, schema };
}

function fakeProvider(overrides: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    id: 'fake', name: 'Fake', rateLimit: { requests: 10, windowMs: 60_000 },
    priority: 1, cacheTTL: 86400, apiKey: 'key',
    canEnrich: () => true,
    enrich: async () => ({ provider: 'fake', confidence: 0.9, data: { email: 'found@example.com' }, rawPayload: {} }),
    ...overrides,
  };
}

describe('EnrichmentPipeline', () => {
  let conn: SqliteConn;
  let contactId: string;

  beforeEach(async () => {
    conn = createTestConn();
    contactId = 'contact-1';
    await conn.db.insert(conn.schema.contacts).values({
      id: contactId, fullName: 'Jane Doe', company: 'Stripe', source: 'linkedin_csv',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });

  it('enriches a contact and persists the result to the contacts table', async () => {
    const pipeline = new EnrichmentPipeline(conn, [fakeProvider()]);
    const summary = await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }]);

    expect(summary.enriched).toBe(1);
    const [contact] = await conn.db.select().from(conn.schema.contacts).where(eq(conn.schema.contacts.id, contactId));
    expect(contact!.email).toBe('found@example.com');
  });

  it('skips providers whose canEnrich returns false', async () => {
    const pipeline = new EnrichmentPipeline(conn, [fakeProvider({ canEnrich: () => false })]);
    const summary = await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe' }]);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped[0]!.reason).toMatch(/not applicable/);
  });

  it('uses a cached result instead of calling enrich again', async () => {
    let callCount = 0;
    const provider = fakeProvider({
      enrich: async () => {
        callCount++;
        return { provider: 'fake', confidence: 0.9, data: { email: 'found@example.com' }, rawPayload: {} };
      },
    });
    const pipeline = new EnrichmentPipeline(conn, [provider]);

    await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }]);
    await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }]);

    expect(callCount).toBe(1);
  });

  it('bypasses the cache when force is set', async () => {
    let callCount = 0;
    const provider = fakeProvider({
      enrich: async () => {
        callCount++;
        return { provider: 'fake', confidence: 0.9, data: { email: 'found@example.com' }, rawPayload: {} };
      },
    });
    const pipeline = new EnrichmentPipeline(conn, [provider]);

    await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }]);
    await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }], { force: true });

    expect(callCount).toBe(2);
  });

  it('respects the rate limit across a batch', async () => {
    const provider = fakeProvider({ rateLimit: { requests: 1, windowMs: 60_000 } });
    const pipeline = new EnrichmentPipeline(conn, [provider]);

    await conn.db.insert(conn.schema.contacts).values({
      id: 'contact-2', fullName: 'John Smith', company: 'Google', source: 'linkedin_csv',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const summary = await pipeline.enrichBatch([
      { id: contactId, fullName: 'Jane Doe', company: 'Stripe' },
      { id: 'contact-2', fullName: 'John Smith', company: 'Google' },
    ]);

    expect(summary.enriched).toBe(1);
    expect(summary.skipped.some((s) => s.reason.includes('rate limited'))).toBe(true);
  });

  it('continues to the next provider when one throws', async () => {
    const failing = fakeProvider({ id: 'failing', enrich: async () => { throw new Error('API down'); } });
    const working = fakeProvider({ id: 'working', priority: 2 });
    const pipeline = new EnrichmentPipeline(conn, [failing, working]);

    const summary = await pipeline.enrichBatch([{ id: contactId, fullName: 'Jane Doe', company: 'Stripe' }]);

    expect(summary.enriched).toBe(1);
    expect(summary.skipped.some((s) => s.reason.includes('API down'))).toBe(true);
  });
});
