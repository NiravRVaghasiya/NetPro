import { eq } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import type { EnrichableContact, EnrichmentProvider, EnrichmentResult } from './types';
import { getCached, setCached } from './cache';
import { LocalRateLimiter } from './rate-limiter';

export interface EnrichSummary {
  enriched: number;
  skipped: Array<{ contactId: string; reason: string }>;
}

export class EnrichmentPipeline {
  private providers: EnrichmentProvider[];
  private rateLimiters = new Map<string, LocalRateLimiter>();

  constructor(
    private conn: SqliteConn | PgConn,
    providers: EnrichmentProvider[]
  ) {
    this.providers = [...providers].sort((a, b) => a.priority - b.priority);
    for (const provider of this.providers) {
      this.rateLimiters.set(
        provider.id,
        new LocalRateLimiter({ defaultRate: provider.rateLimit.requests, windowMs: provider.rateLimit.windowMs })
      );
    }
  }

  async enrichContact(
    contact: EnrichableContact,
    opts?: { force?: boolean }
  ): Promise<{ results: EnrichmentResult[]; skipped: string[] }> {
    const results: EnrichmentResult[] = [];
    const skipped: string[] = [];

    for (const provider of this.providers) {
      if (!provider.canEnrich(contact)) {
        skipped.push(`${provider.id}: not applicable or no key configured`);
        continue;
      }

      if (!opts?.force) {
        const cached = await getCached(this.conn, contact.id, provider.id);
        if (cached && !cached.stale) {
          results.push(cached.result);
          continue;
        }
      }

      const limiter = this.rateLimiters.get(provider.id)!;
      if (!limiter.consume(provider.id).allowed) {
        skipped.push(`${provider.id}: rate limited`);
        continue;
      }

      try {
        const result = await provider.enrich(contact);
        await setCached(this.conn, contact.id, provider.id, result, provider.cacheTTL);
        results.push(result);
      } catch (e) {
        skipped.push(`${provider.id}: ${(e as Error).message}`);
      }
    }

    return { results, skipped };
  }

  async enrichBatch(contacts: EnrichableContact[], opts?: { force?: boolean }): Promise<EnrichSummary> {
    const summary: EnrichSummary = { enriched: 0, skipped: [] };

    for (const contact of contacts) {
      const { results, skipped } = await this.enrichContact(contact, opts);
      skipped.forEach((reason) => summary.skipped.push({ contactId: contact.id, reason }));

      if (results.length > 0) {
        const merged = mergeByConfidence(results);
        await persistEnrichment(this.conn, contact.id, merged);
        summary.enriched++;
      }
    }

    return summary;
  }
}

function mergeByConfidence(results: EnrichmentResult[]): Partial<EnrichmentResult['data']> {
  const merged: Record<string, { value: unknown; confidence: number }> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.data)) {
      if (value === undefined || value === null) continue;
      const existing = merged[key];
      if (!existing || result.confidence > existing.confidence) {
        merged[key] = { value, confidence: result.confidence };
      }
    }
  }
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.value])) as Partial<EnrichmentResult['data']>;
}

// NOTE: `conn.db.select()`/`.insert()`/`.update()` don't typecheck against the raw
// `SqliteConn | PgConn` union — Drizzle's per-dialect query builders have incompatible
// overload sets, so TS can't call a method on the union type. Narrowing on
// `conn.dialect` (rather than casting) collapses each branch to a single concrete
// connection type, which resolves cleanly. The query logic is intentionally
// duplicated in each branch — see Task 2's `import/pipeline.ts` / Task 3's `cache.ts`
// for the same pattern.
async function persistEnrichment(
  conn: SqliteConn | PgConn,
  contactId: string,
  data: Partial<EnrichmentResult['data']>
): Promise<void> {
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const key of ['email', 'emailVerified', 'company', 'companyDomain', 'role', 'seniority', 'location', 'country', 'linkedinUrl', 'githubUrl', 'twitterUrl', 'industry'] as const) {
    if (data[key] !== undefined) updates[key] = data[key];
  }

  if (conn.dialect === 'sqlite') {
    await conn.db.update(conn.schema.contacts).set(updates).where(eq(conn.schema.contacts.id, contactId));
    return;
  }

  await conn.db.update(conn.schema.contacts).set(updates).where(eq(conn.schema.contacts.id, contactId));
}
