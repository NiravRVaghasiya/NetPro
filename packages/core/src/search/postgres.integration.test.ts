// Live PostgreSQL coverage for the v2.0 Phase 4 hybrid search engine.
//
// WHY THIS FILE EXISTS. The keyword arm is the only part of search whose SQL
// is genuinely dialect-specific: SQLite matches an FTS5 virtual table kept in
// sync by triggers, Postgres matches a generated `tsvector` column through a
// GIN index. Everything else — RRF, the filters, the facets, pagination — is
// shared, and shared code that has only ever run on SQLite is exactly the gap
// that hid the v1 migration race. So the *whole* engine is exercised here
// through `searchContacts`, not just the raw SQL.
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// `npm test` stays hermetic and offline. CI's postgres job supplies it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@netpro/db/src/schema.pg';
import { runMigrations } from '@netpro/db';
import type { PgConn } from '@netpro/db';
import { searchContacts } from './query';
import { reindexSearchIndex, searchIndexStatus } from './indexer';
import type { EmbeddingProvider } from './embeddings';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const dbName = `netpro_core_search_${Date.now().toString(36)}`;

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Deterministic offline embedder — the semantic arm must never need network. */
function topicEmbedder(model = 'fake-model'): EmbeddingProvider {
  const lexicon: Record<string, number[]> = {
    payments: [1, 0, 0],
    stripe: [1, 0, 0],
    fintech: [1, 0, 0],
    design: [0, 1, 0],
    designer: [0, 1, 0],
    product: [0, 0, 1],
    manager: [0, 0, 1],
    roadmap: [0, 0, 1],
  };
  return {
    id: 'openai',
    model,
    async embed(texts: string[]) {
      return texts.map((text) => {
        const vector = [0, 0, 0];
        for (const word of text.toLowerCase().split(/[^a-z]+/)) {
          const hit = lexicon[word];
          if (hit) for (let i = 0; i < 3; i++) vector[i]! += hit[i]!;
        }
        return vector;
      });
    },
  };
}

describeIfPg('hybrid search against live PostgreSQL', () => {
  let conn: PgConn;

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(`CREATE DATABASE "${dbName}"`);
    });
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString() });
    conn = { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
    await runMigrations(conn, { force: true });

    await conn.db.insert(schema.contacts).values([
      {
        id: 'p1',
        fullName: 'Jane Doe',
        email: 'jane@stripe.com',
        company: 'Stripe',
        role: 'Senior Engineer',
        seniority: 'senior',
        industry: 'Fintech',
        location: 'Berlin',
        headline: 'Payments infrastructure',
        notes: 'Introduced at PyCon',
        source: 'test',
        relationshipScore: 0.8,
      },
      {
        id: 'p2',
        fullName: 'John Smith',
        email: 'john@acme.com',
        company: 'Acme',
        role: 'Product Manager',
        seniority: 'mid',
        industry: 'Software',
        location: 'San Francisco',
        headline: 'Building the web',
        source: 'test',
        relationshipScore: 0.5,
      },
      {
        id: 'p3',
        fullName: 'Alice Wong',
        company: 'Acme',
        role: 'Designer',
        seniority: 'junior',
        industry: 'Software',
        location: 'Berlin',
        headline: 'Design systems',
        source: 'test',
        relationshipScore: 0.3,
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await conn?.pool.end();
    await withAdmin(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [dbName]
      );
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }).catch(() => {
      // Best effort cleanup of a throwaway database.
    });
  }, 60_000);

  it('reports the keyword index as available after migration 0004', async () => {
    const status = await searchIndexStatus(conn);
    expect(status.keywordIndexAvailable).toBe(true);
    expect(status.contacts).toBe(3);
    expect(status.indexed).toBe(0);
  });

  it('degrades to portable — with an honest reason — before anything is indexed', async () => {
    const res = await searchContacts(conn, { query: 'stripe', mode: 'keyword' });
    expect(res.engine.arms.keyword).toMatchObject({ used: false, reason: 'index_empty' });
    expect(res.contacts.map((c) => c.id)).toEqual(['p1']);
  });

  it('produces index rows and skips unchanged ones on a rerun', async () => {
    expect(await reindexSearchIndex(conn)).toMatchObject({
      scanned: 3,
      indexed: 3,
      skipped: 0,
    });
    expect(await reindexSearchIndex(conn)).toMatchObject({ indexed: 0, skipped: 3 });
    expect((await searchIndexStatus(conn)).indexed).toBe(3);
  });

  it('runs the tsvector arm and fuses it with the portable arm', async () => {
    const res = await searchContacts(conn, { query: 'payments', mode: 'keyword' });
    expect(res.engine.mode).toBe('keyword');
    expect(res.engine.arms.keyword.used).toBe(true);
    expect(res.contacts.map((c) => c.id)).toEqual(['p1']);
  });

  it('stems and prefix-matches — the substring engine can do neither', async () => {
    // English stemming: "engineering" and the stored "Senior Engineer" both
    // reduce to the lexeme `engin`, so the keyword arm connects them.
    //
    // The discriminator has to be a query that is NOT a substring of the
    // document, which is subtler than it looks: "payment" would prove nothing
    // here, because it is a literal substring of "Payments infrastructure" and
    // the portable arm finds it too. (It did, and this test caught it.)
    const stem = await searchContacts(conn, { query: 'engineering', mode: 'keyword' });
    expect(stem.contacts.map((c) => c.id)).toContain('p1');
    expect(stem.engine.arms.keyword.hits).toBeGreaterThan(0);
    // Nothing stored contains the string "engineering", so substring search
    // genuinely cannot reach it.
    expect((await searchContacts(conn, { query: 'engineering' })).contacts).toEqual([]);

    // Prefix matching goes through the GIN index (`stri:*`), not a LIKE scan.
    const prefix = await searchContacts(conn, { query: 'stri', mode: 'keyword' });
    expect(prefix.engine.arms.keyword.hits).toBeGreaterThan(0);
    expect(prefix.contacts.map((c) => c.id)).toContain('p1');
  });

  it('matches indexed notes, which the portable engine does not read', async () => {
    expect((await searchContacts(conn, { query: 'pycon' })).contacts).toEqual([]);
    const res = await searchContacts(conn, { query: 'pycon', mode: 'keyword' });
    expect(res.contacts.map((c) => c.id)).toEqual(['p1']);
  });

  it('keeps filter/sort/pagination parity with the portable engine', async () => {
    for (const filters of [
      { company: 'acme' },
      { seniority: 'junior' },
      { minScore: 0.6 },
      { hasEmail: true },
    ] as const) {
      const portable = await searchContacts(conn, { query: 'e', ...filters, limit: 100 });
      const hybrid = await searchContacts(conn, {
        query: 'e',
        mode: 'keyword',
        ...filters,
        limit: 100,
      });
      expect(new Set(hybrid.contacts.map((c) => c.id))).toEqual(
        new Set(portable.contacts.map((c) => c.id))
      );
    }

    const byName = await searchContacts(conn, {
      query: 'e',
      mode: 'keyword',
      sort: 'name',
      limit: 100,
    });
    const names = byName.contacts.map((c) => c.fullName);
    expect(names).toEqual([...names].sort());
  });

  it('never surfaces a soft-deleted contact even with a stale index row', async () => {
    await conn.db.execute(sql`UPDATE contacts SET deleted_at = now()::text WHERE id = 'p3'`);
    const res = await searchContacts(conn, { query: 'design', mode: 'keyword' });
    expect(res.contacts.map((c) => c.id)).not.toContain('p3');
    // And a reindex prunes the row entirely.
    expect(await reindexSearchIndex(conn)).toMatchObject({ pruned: 1 });
    await conn.db.execute(sql`UPDATE contacts SET deleted_at = NULL WHERE id = 'p3'`);
    await reindexSearchIndex(conn);
  });

  it('escapes tsquery grammar instead of erroring on it', async () => {
    // Unsanitized, each of these is a syntax error inside to_tsquery.
    for (const query of ['a & b', 'a | b', '!nope', '(unbalanced', ':*', "o'brien"]) {
      const res = await searchContacts(conn, { query, mode: 'keyword' });
      expect(res.engine.arms.keyword.reason).not.toBe('provider_error');
    }
  });

  it('runs the semantic arm over vectors stored as portable JSON', async () => {
    const embedder = topicEmbedder();
    const summary = await reindexSearchIndex(conn, { embedder, force: true });
    expect(summary.embedded).toBe(3);
    expect((await searchIndexStatus(conn)).embeddingModels).toEqual(['fake-model']);

    const res = await searchContacts(conn, { query: 'roadmap', mode: 'hybrid' }, { embedder });
    expect(res.engine.mode).toBe('hybrid');
    expect(res.engine.arms.semantic.used).toBe(true);
    // Nothing lexical matches "roadmap"; only the topic vector reaches the PM.
    expect(res.contacts.map((c) => c.id)).toEqual(['p2']);
    expect((await searchContacts(conn, { query: 'roadmap', mode: 'keyword' })).contacts).toEqual([]);
  });

  it('falls back to the lexical arms when the embeddings provider is down', async () => {
    const broken: EmbeddingProvider = {
      id: 'openai',
      model: 'fake-model',
      async embed() {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const res = await searchContacts(
      conn,
      { query: 'payments', mode: 'hybrid' },
      { embedder: broken }
    );
    expect(res.engine.arms.semantic).toMatchObject({ used: false, reason: 'provider_error' });
    expect(res.contacts.map((c) => c.id)).toEqual(['p1']);
  });
});
