import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';
import { serializePayload, deserializePayload, getCached, setCached } from './cache';
import type { SqliteConn } from '@netpro/db';
import type { EnrichmentResult } from './types';

describe('serializePayload / deserializePayload', () => {
  it('passes objects through unchanged for sqlite', () => {
    const payload = { data: { email: 'jane@example.com' }, raw: {} };
    expect(serializePayload('sqlite', payload)).toBe(payload);
    expect(deserializePayload('sqlite', payload)).toEqual(payload);
  });

  it('stringifies on write and parses on read for postgresql', () => {
    const payload = { data: { email: 'jane@example.com' }, raw: {} };
    const serialized = serializePayload('postgresql', payload);
    expect(typeof serialized).toBe('string');
    expect(deserializePayload('postgresql', serialized)).toEqual(payload);
  });

  it('deserializePayload tolerates an already-parsed object even for postgresql', () => {
    const payload = { data: {}, raw: {} };
    expect(deserializePayload('postgresql', payload)).toEqual(payload);
  });
});

function createTestConn(): SqliteConn {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE enrichments (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      data_type TEXT NOT NULL,
      raw_payload TEXT,
      confidence REAL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      stale INTEGER DEFAULT 0
    );
  `);
  return { dialect: 'sqlite', db, schema };
}

describe('getCached / setCached', () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
  });

  it('returns null when nothing is cached', async () => {
    expect(await getCached(conn, 'contact-1', 'hunter')).toBeNull();
  });

  it('round-trips a cached result', async () => {
    const result: EnrichmentResult = {
      provider: 'hunter',
      confidence: 0.9,
      data: { email: 'jane@example.com', emailVerified: true },
      rawPayload: { score: 90 },
    };

    await setCached(conn, 'contact-1', 'hunter', result, 86400);
    const cached = await getCached(conn, 'contact-1', 'hunter');

    expect(cached).not.toBeNull();
    expect(cached!.result.data).toEqual(result.data);
    expect(cached!.stale).toBe(false);
  });

  it('marks a result stale once its TTL has elapsed', async () => {
    const result: EnrichmentResult = { provider: 'hunter', confidence: 0.9, data: {}, rawPayload: {} };
    await setCached(conn, 'contact-1', 'hunter', result, -1); // already-expired TTL

    const cached = await getCached(conn, 'contact-1', 'hunter');
    expect(cached!.stale).toBe(true);
  });
});
