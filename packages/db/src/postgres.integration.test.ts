// Live PostgreSQL integration tests.
//
// Phases 1–5 shipped Postgres support that compiled and had committed
// migrations, but was never executed against a real PostgreSQL server — the
// Phase 5 verification record says so explicitly. That gap is what let the
// concurrent-migration race below reach the v1.0 release candidate.
//
// These tests are SKIPPED unless NETPRO_TEST_DATABASE_URL points at a
// disposable PostgreSQL server, so the default `npm test` stays hermetic and
// offline. CI runs them against a postgres service container; locally:
//
//   docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=netpro postgres:16-alpine
//   NETPRO_TEST_DATABASE_URL=postgresql://postgres:netpro@127.0.0.1:5433/postgres \
//     npm test -w packages/db
//
// Each test provisions its own throwaway database so runs cannot interfere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq } from 'drizzle-orm';
import * as schema from './schema.pg';
import type { PgConn } from './index';
import {
  appliedMigrationCount,
  pendingMigrationTotal,
  resolveMigrationsFolder,
  runMigrations,
} from './migrate';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const created: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `netpro_test_${label}_${Date.now().toString(36)}`;
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
  created.push(name);
  return name;
}

function connect(name: string): PgConn {
  const pool = new Pool({ connectionString: databaseUrl(name) });
  return { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
}

describeIfPg('PostgreSQL integration', () => {
  let dbName: string;
  let conn: PgConn;

  beforeAll(async () => {
    dbName = await freshDatabase('main');
    conn = connect(dbName);
    await runMigrations(conn, { force: true });
  }, 60_000);

  afterAll(async () => {
    await conn?.pool.end();
    for (const name of created) {
      await withAdmin(async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [name]
        );
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      }).catch(() => {
        // Best effort cleanup of a throwaway database.
      });
    }
  }, 60_000);

  it('applies every committed migration to a fresh database', async () => {
    expect(await appliedMigrationCount(conn)).toBe(
      pendingMigrationTotal('postgresql')
    );

    const tables = await conn.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = tables.rows.map((row) => row.table_name);
    // The Auth.js adapter tables use singular names; the domain tables plural.
    for (const expected of [
      'contacts',
      'interactions',
      'edges',
      'enrichments',
      'campaigns',
      'campaign_recipients',
      'search_index',
      'profile_views',
      'follow_ups',
      'activity_log',
      'profile_cards',
      'events',
      'event_attendees',
      'content_items',
      'content_metrics',
      'content_mentions',
      'user',
      'account',
      'session',
      'verificationToken',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent when re-run against an already migrated database', async () => {
    const before = await appliedMigrationCount(conn);
    await runMigrations(conn, { force: true });
    await runMigrations(conn, { force: true });
    expect(await appliedMigrationCount(conn)).toBe(before);
  });

  it('round-trips a contact through real Postgres types', async () => {
    await conn.db.insert(schema.contacts).values({
      id: 'pg-roundtrip',
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'test',
      relationshipScore: 0.75,
      interactionCount: 3,
      emailVerified: true,
    });
    const rows = await conn.db.select().from(schema.contacts);
    const row = rows.find((r) => r.id === 'pg-roundtrip');
    expect(row?.fullName).toBe('Ada Lovelace');
    // real/boolean/integer must survive the pg driver, not just SQLite's
    // permissive dynamic typing.
    expect(row?.relationshipScore).toBeCloseTo(0.75);
    expect(row?.emailVerified).toBe(true);
    expect(row?.interactionCount).toBe(3);
  });

  it('adds contacts.skills as nullable text that round-trips a JSON verdict (phase 5)', async () => {
    const col = await conn.db.execute<{ data_type: string; is_nullable: string }>(
      sql`SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'contacts' AND column_name = 'skills'`
    );
    expect(col.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);

    await conn.db.insert(schema.contacts).values({
      id: 'pg-skills',
      fullName: 'Grace Hopper',
      source: 'test',
      skills: JSON.stringify(['python', 'kubernetes']),
    });
    const rows = await conn.db.select().from(schema.contacts);
    const row = rows.find((r) => r.id === 'pg-skills');
    // Postgres stores the verdict as the exact JSON text the core wrote, so the
    // shared reader can JSON.parse it identically on both dialects.
    expect(row?.skills).toBe('["python","kubernetes"]');
    expect(JSON.parse(row!.skills!)).toEqual(['python', 'kubernetes']);
    const untouched = rows.find((r) => r.id === 'pg-roundtrip');
    expect(untouched?.skills).toBeNull();
  });

  it('adds the v2.5 phase-1 privacy columns and indexes to profile_views (0006)', async () => {
    const cols = await conn.db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      sql`SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = 'profile_views'
          ORDER BY column_name`
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    for (const added of [
      'viewer_fingerprint',
      'is_bot',
      'is_owner_view',
      'session_id',
      'duration_ms',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'viewed_card_id',
    ]) {
      expect(byName.has(added)).toBe(true);
    }
    // The flags are NOT NULL booleans defaulting to false on Postgres too.
    expect(byName.get('is_bot')).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    });
    expect(byName.get('is_owner_view')?.data_type).toBe('boolean');
    expect(byName.get('duration_ms')?.data_type).toBe('integer');

    const indexes = await conn.db.execute<{ indexname: string; indexdef: string }>(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'profile_views'`
    );
    const byIndexName = new Map(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    for (const expected of [
      'idx_profile_views_time',
      'idx_profile_views_resolved',
      'idx_profile_views_page',
      'idx_profile_views_fingerprint_time',
      'idx_profile_views_is_bot',
    ]) {
      expect(byIndexName.has(expected)).toBe(true);
    }
    // Two partial indexes: resolved contacts only, and non-bot timeline scans.
    expect(byIndexName.get('idx_profile_views_resolved')).toMatch(/WHERE/i);
    expect(byIndexName.get('idx_profile_views_is_bot')).toMatch(/WHERE .*is_bot.*= false/i);

    await conn.db.insert(schema.profileViews).values({
      id: 'pg-view',
      viewerIp: 'a1b2c3d4e5f60718',
      viewerFingerprint: '90abcdef12345678',
      isBot: false,
      isOwnerView: true,
      sessionId: 'sess-1',
      durationMs: 4230,
      utmSource: 'linkedin',
      viewedCardId: 'default',
      viewedPage: '/card',
    });
    const rows = await conn.db
      .select()
      .from(schema.profileViews)
      .where(eq(schema.profileViews.id, 'pg-view'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      viewerIp: 'a1b2c3d4e5f60718',
      isBot: false,
      isOwnerView: true,
      durationMs: 4230,
      utmSource: 'linkedin',
      viewedCardId: 'default',
    });
    // No raw IP ever persisted: the column only ever holds a hex hash.
    expect(row.viewerIp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('creates the v2.5 phase-4 content tables, unique key and indexes (0007)', async () => {
    const cols = await conn.db.execute<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name IN ('content_items', 'content_metrics', 'content_mentions')
          ORDER BY table_name, column_name`
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const expected of [
      'url',
      'url_norm',
      'title',
      'platform',
      'type',
      'published_at',
      'author',
      'tags',
      'summary',
      'source',
      'content_id',
      'fetched_at',
      'views',
      'likes',
      'comments',
      'shares',
      'bookmarks',
      'raw_payload',
      'contact_id',
      'context',
    ]) {
      expect(names).toContain(expected);
    }
    // Metrics are plain integers (nullable — unreported is null, not zero).
    const views = cols.rows.find((r) => r.column_name === 'views');
    expect(views?.data_type).toBe('integer');

    // url_norm is UNIQUE: the dedupe key cannot double-count a post.
    const uniques = await conn.db.execute<{ conname: string }>(
      sql`SELECT conname FROM pg_constraint
          WHERE conrelid = 'content_items'::regclass AND contype = 'u'`
    );
    expect(uniques.rows.map((r) => r.conname)).toContain('content_items_url_norm_unique');

    const indexes = await conn.db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes
          WHERE tablename IN ('content_items', 'content_metrics', 'content_mentions')`
    );
    const indexNames = indexes.rows.map((r) => r.indexname);
    for (const expected of [
      'idx_content_items_platform',
      'idx_content_items_published',
      'idx_content_metrics_item_time',
      'idx_content_metrics_time',
      'idx_content_mentions_contact',
      'idx_content_mentions_content',
    ]) {
      expect(indexNames).toContain(expected);
    }

    // Typed round-trip through the new tables (tags as stringified JSON text).
    await conn.db.insert(schema.contentItems).values({
      id: 'pg-content',
      url: 'https://example.com/pg?utm_source=x',
      urlNorm: 'https://example.com/pg',
      title: 'Postgres content',
      platform: 'blog',
      tags: JSON.stringify(['postgres']),
    });
    await conn.db.insert(schema.contentMetrics).values({
      id: 'pg-metric',
      contentId: 'pg-content',
      fetchedAt: '2026-09-08T00:00:00.000Z',
      views: 7,
      rawPayload: JSON.stringify({ page_views: 7 }),
    });
    const items = await conn.db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, 'pg-content'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      urlNorm: 'https://example.com/pg',
      platform: 'blog',
      source: 'manual',
    });
    expect(JSON.parse(items[0]!.tags!)).toEqual(['postgres']);
    // The unique key bites on a second row with the same normalized URL.
    await expect(
      conn.db.insert(schema.contentItems).values({
        id: 'pg-content-dup',
        url: 'https://example.com/pg',
        urlNorm: 'https://example.com/pg',
        title: 'Duplicate',
        platform: 'blog',
      })
    ).rejects.toThrow();
  });

  it('stores the profile card as plain JSON text in both dialects', async () => {
    const profile = JSON.stringify({ fullName: 'Grace Hopper' });
    await conn.db
      .insert(schema.profileCards)
      .values({ id: 'default', draft: profile, updatedAt: new Date().toISOString() });
    const [card] = await conn.db.select().from(schema.profileCards);
    // Postgres must hand back the raw string, matching SQLite. A jsonb column
    // would auto-decode here and silently diverge from the SQLite dialect.
    expect(typeof card?.draft).toBe('string');
    expect(card?.draft).toBe(profile);
  });

  it(
    'survives concurrent cold-start migrations of one fresh database',
    async () => {
      // THE PHASE 6 REGRESSION TEST.
      //
      // A hosted deployment can cold-start many instances at once, and each
      // one migrates on startup. Calling drizzle's migrate() directly here
      // reproducibly failed 5 of 6 workers against real PostgreSQL 18:
      //   -> Failed query: CREATE TABLE "account" (...)
      //   -> Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
      // (IF NOT EXISTS is itself racy in Postgres: the check and the create
      // are not atomic.) runMigrations() serializes them with an advisory
      // lock, so exactly one applies and the rest no-op.
      const name = await freshDatabase('race');
      const workers = Array.from({ length: 6 }, () => connect(name));
      try {
        const results = await Promise.allSettled(
          workers.map((worker) => runMigrations(worker, { force: true }))
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(
          rejected.map((r) => String((r as PromiseRejectedResult).reason?.message))
        ).toEqual([]);

        // Applied exactly once, not six times.
        expect(await appliedMigrationCount(workers[0]!)).toBe(
          pendingMigrationTotal('postgresql')
        );
      } finally {
        await Promise.all(workers.map((worker) => worker.pool.end()));
      }
    },
    120_000
  );

  it('caches migration work per process so warm requests do not re-migrate', async () => {
    const cached = connect(dbName);
    try {
      const first = runMigrations(cached);
      const second = runMigrations(cached);
      // Same in-flight promise, not a second round trip.
      expect(second).toBe(first);
      await first;
    } finally {
      await cached.pool.end();
    }
  });

  it('exposes a migrations folder for the postgres dialect', () => {
    expect(resolveMigrationsFolder('postgresql')).toMatch(/migrations[/\\]postgres$/);
  });

  // ── v2.0 Phase 4: hybrid search ────────────────────────────────────────
  //
  // The keyword arm is the one part of search whose SQL genuinely differs by
  // dialect (FTS5 vs tsvector). SQLite is covered by the in-memory fixture in
  // packages/core; this is the half that only a real server can prove — the
  // generated column's immutability, the GIN index, and to_tsquery's prefix
  // operator all fail at DDL/plan time, not at typecheck time.
  describe('hybrid search (phase 4)', () => {
    let searchDb: string;
    let searchConn: PgConn;

    beforeAll(async () => {
      searchDb = await freshDatabase('search');
      searchConn = connect(searchDb);
      await runMigrations(searchConn, { force: true });

      await searchConn.db.insert(schema.contacts).values([
        {
          id: 's1',
          fullName: 'Jane Doe',
          email: 'jane@stripe.com',
          company: 'Stripe',
          role: 'Senior Engineer',
          headline: 'Payments infrastructure',
          location: 'Berlin',
          source: 'test',
          relationshipScore: 0.8,
        },
        {
          id: 's2',
          fullName: 'John Smith',
          email: 'john@acme.com',
          company: 'Acme',
          role: 'Product Manager',
          headline: 'Building the web',
          location: 'San Francisco',
          source: 'test',
          relationshipScore: 0.5,
        },
      ]);
    }, 60_000);

    afterAll(async () => {
      await searchConn?.pool.end();
    });

    it('creates the generated tsvector column and its GIN index', async () => {
      const columns = await searchConn.db.execute<{
        column_name: string;
        data_type: string;
        is_generated: string;
      }>(
        sql`SELECT column_name, data_type, is_generated
            FROM information_schema.columns
            WHERE table_name = 'search_index'
            ORDER BY column_name`
      );
      const byName = new Map(columns.rows.map((r) => [r.column_name, r]));
      for (const added of [
        'embedding_dim',
        'embedding_updated_at',
        'content_hash',
        'search_vector',
      ]) {
        expect(byName.has(added)).toBe(true);
      }
      expect(byName.get('search_vector')?.data_type).toBe('tsvector');
      // ALWAYS = a stored generated column: no producer can forget to fill it,
      // and no trigger has to exist (the SQLite side needs three).
      expect(byName.get('search_vector')?.is_generated).toBe('ALWAYS');

      const indexes = await searchConn.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'search_index'`
      );
      const gin = indexes.rows.find((r) => r.indexname === 'idx_search_index_vector');
      expect(gin?.indexdef).toMatch(/USING gin/i);
      expect(
        indexes.rows.some((r) => r.indexname === 'idx_search_index_updated_at')
      ).toBe(true);
    });

    it('populates search_vector automatically and matches with a prefix tsquery', async () => {
      await searchConn.db.insert(schema.searchIndex).values([
        {
          contactId: 's1',
          searchText: 'jane doe jane@stripe.com payments infrastructure stripe senior engineer berlin',
          contentHash: 'hash-1',
          updatedAt: new Date().toISOString(),
        },
        {
          contactId: 's2',
          searchText: 'john smith john@acme.com building the web acme product manager san francisco',
          contentHash: 'hash-2',
          updatedAt: new Date().toISOString(),
        },
      ]);

      // Exactly the query the keyword arm issues (arms.ts::keywordArm).
      const hits = await searchConn.db.execute<{ id: string }>(
        sql`SELECT search_index.contact_id AS id
            FROM search_index
            JOIN contacts ON contacts.id = search_index.contact_id
            WHERE search_index.search_vector @@ to_tsquery('english', ${'payment:*'})
              AND contacts.deleted_at IS NULL
            ORDER BY ts_rank(search_index.search_vector, to_tsquery('english', ${'payment:*'})) DESC`
      );
      // Prefix matching plus English stemming: "payment:*" finds "payments".
      expect(hits.rows.map((r) => r.id)).toEqual(['s1']);
    });

    it('regenerates search_vector when the document changes', async () => {
      await searchConn.db.execute(
        sql`UPDATE search_index SET search_text = 'jane doe acme edge functions'
            WHERE contact_id = 's1'`
      );
      const stale = await searchConn.db.execute<{ id: string }>(
        sql`SELECT contact_id AS id FROM search_index
            WHERE search_vector @@ to_tsquery('english', ${'payment:*'})`
      );
      expect(stale.rows).toEqual([]);
      const fresh = await searchConn.db.execute<{ id: string }>(
        sql`SELECT contact_id AS id FROM search_index
            WHERE search_vector @@ to_tsquery('english', ${'edge:*'})`
      );
      expect(fresh.rows.map((r) => r.id)).toEqual(['s1']);
    });

    it('refuses to let a generated column be written directly', async () => {
      // Guards the producer contract: search_vector is derived, never supplied.
      await expect(
        searchConn.db.execute(
          sql`UPDATE search_index SET search_vector = to_tsvector('english', 'nope') WHERE contact_id = 's1'`
        )
      ).rejects.toThrow();
    });

    it('cascades index rows away with the contact', async () => {
      await searchConn.db.execute(sql`DELETE FROM contacts WHERE id = 's2'`);
      const rows = await searchConn.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM search_index WHERE contact_id = 's2'`
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('round-trips a stored embedding as portable JSON text', async () => {
      // The semantic arm reads this back with JSON.parse on both dialects, so
      // Postgres must hand back the exact string it was given.
      const vector = JSON.stringify([0.125, -0.25, 0.5]);
      await searchConn.db.execute(
        sql`UPDATE search_index
            SET embedding = ${vector}, embedding_model = 'text-embedding-3-small',
                embedding_dim = 3, embedding_updated_at = ${new Date().toISOString()}
            WHERE contact_id = 's1'`
      );
      const [row] = (
        await searchConn.db.execute<{
          embedding: string;
          embedding_dim: number;
          embedding_model: string;
        }>(
          sql`SELECT embedding, embedding_dim, embedding_model FROM search_index WHERE contact_id = 's1'`
        )
      ).rows;
      expect(typeof row?.embedding).toBe('string');
      expect(row?.embedding).toBe(vector);
      expect(row?.embedding_dim).toBe(3);
      expect(JSON.parse(row!.embedding)).toEqual([0.125, -0.25, 0.5]);
    });

    it('needs no pgvector — the semantic arm is portable JSON by design', async () => {
      // v2.0 stores embeddings as JSON text rather than a `vector` column, so
      // a managed Postgres without the extension (most of them) still runs
      // hybrid search. A native column + ANN index is a later optimization,
      // which means the *absence* of the extension is the supported path and
      // has to stay that way. This asserts it against the whole server, not
      // just the one table.
      const { rows } = await searchConn.db.execute<{ extname: string }>(
        sql`SELECT extname FROM pg_extension`
      );
      const names = rows.map((r) => r.extname);
      expect(names).toContain('plpgsql');
      expect(names).not.toContain('vector');
    });
  });
});
