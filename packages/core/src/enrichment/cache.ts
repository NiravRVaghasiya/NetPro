import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import type { EnrichmentResult } from './types';

export interface CachedEnrichment {
  result: EnrichmentResult;
  stale: boolean;
}

type Dialect = 'sqlite' | 'postgresql';

/** SQLite's `rawPayload` column is `{mode:'json'}` (auto object <-> JSON); Postgres's is plain `text`. */
export function serializePayload(dialect: 'sqlite', payload: Record<string, unknown>): Record<string, unknown>;
export function serializePayload(dialect: 'postgresql', payload: Record<string, unknown>): string;
export function serializePayload(dialect: Dialect, payload: Record<string, unknown>): unknown {
  return dialect === 'postgresql' ? JSON.stringify(payload) : payload;
}

export function deserializePayload(dialect: Dialect, raw: unknown): Record<string, unknown> {
  if (dialect === 'postgresql' && typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return (raw as Record<string, unknown>) ?? {};
}

function toCachedEnrichment(
  dialect: Dialect,
  row: { provider: string; rawPayload: unknown; confidence: number | null; expiresAt: string | null; stale: boolean | null }
): CachedEnrichment {
  const payload = deserializePayload(dialect, row.rawPayload);
  const expired = row.expiresAt ? new Date(row.expiresAt).getTime() < Date.now() : false;

  return {
    result: {
      provider: row.provider,
      confidence: row.confidence ?? 0,
      data: (payload.data as EnrichmentResult['data']) ?? {},
      rawPayload: (payload.raw as Record<string, unknown>) ?? {},
    },
    stale: Boolean(row.stale) || expired,
  };
}

// NOTE: `conn.db.select()`/`.insert()` don't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so TS can't
// call a method on the union type. Narrowing on `conn.dialect` (rather than casting) collapses
// each branch to a single concrete connection type, which resolves cleanly. The query logic is
// intentionally duplicated in each branch — see Task 2's `pipeline.ts` for the same pattern.
export async function getCached(conn: SqliteConn | PgConn, contactId: string, provider: string): Promise<CachedEnrichment | null> {
  if (conn.dialect === 'sqlite') {
    const rows = await conn.db.select().from(conn.schema.enrichments)
      .where(and(eq(conn.schema.enrichments.contactId, contactId), eq(conn.schema.enrichments.provider, provider)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toCachedEnrichment(conn.dialect, row);
  }

  const rows = await conn.db.select().from(conn.schema.enrichments)
    .where(and(eq(conn.schema.enrichments.contactId, contactId), eq(conn.schema.enrichments.provider, provider)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toCachedEnrichment(conn.dialect, row);
}

export async function setCached(
  conn: SqliteConn | PgConn,
  contactId: string,
  provider: string,
  result: EnrichmentResult,
  ttlSeconds: number
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  if (conn.dialect === 'sqlite') {
    const payload = serializePayload(conn.dialect, { data: result.data, raw: result.rawPayload });
    await conn.db.insert(conn.schema.enrichments).values({
      id: randomUUID(),
      contactId,
      provider,
      dataType: 'profile',
      rawPayload: payload,
      confidence: result.confidence,
      fetchedAt: now.toISOString(),
      expiresAt,
      stale: false,
    });
    return;
  }

  const payload = serializePayload(conn.dialect, { data: result.data, raw: result.rawPayload });
  await conn.db.insert(conn.schema.enrichments).values({
    id: randomUUID(),
    contactId,
    provider,
    dataType: 'profile',
    rawPayload: payload,
    confidence: result.confidence,
    fetchedAt: now.toISOString(),
    expiresAt,
    stale: false,
  });
}
