// Live PostgreSQL coverage for the v2.5 Phase 4 content tracker.
//
// WHY THIS FILE EXISTS. The content module reads through raw ANSI SQL (the
// same `rawAll` helper the search indexer and the events module use) and
// writes through Drizzle — and the portability claims are sharp-edged here:
// the row-value `(fetched_at, created_at, id)` comparison in the overview,
// `lower(tags) LIKE … ESCAPE '\'` over a JSON text column, JSON columns that
// are JSON-mode on SQLite but plain text on Postgres, and the UNIQUE
// constraint on `url_norm`. A second dialect is the only thing that can
// contradict them.
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// `npm test` stays hermetic and offline. CI's postgres job supplies it.
//
// ONE DATABASE, TESTS IN ORDER. All tests share one database and build on
// each other the way the events suite does — the import in the first test is
// what the later assertions read back. Any new test has to be written against
// the state the tests above it left behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@netpro/db/src/schema.pg";
import { runMigrations } from "@netpro/db";
import type { PgConn } from "@netpro/db";
import {
  addContentItem,
  addContentMention,
  contentStatus,
  deleteContentItem,
  getContentItem,
  getContentMetricsSeries,
  getContentOverview,
  importContent,
  listContactContent,
  listContentItems,
  listContentMentions,
  recordMetrics,
  resolveContentRef,
} from "./index";

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const dbName = `netpro_core_content_${Date.now().toString(36)}`;
const now = new Date("2026-09-08T12:00:00.000Z");

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describeIfPg("content tracker against live PostgreSQL", () => {
  let conn: PgConn;

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(`CREATE DATABASE "${dbName}"`);
    });
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString() });
    conn = {
      dialect: "postgresql",
      db: drizzle(pool, { schema }),
      schema,
      pool,
    };
    await runMigrations(conn, { force: true });

    await conn.db.insert(schema.contacts).values([
      {
        id: "a",
        fullName: "Ada Lovelace",
        email: "ada@engines.dev",
        source: "test",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "b",
        fullName: "Bob Builder",
        email: "bob@builders.io",
        source: "test",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "gone",
        fullName: "Ghost",
        email: "ghost@example.com",
        source: "test",
        deletedAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await conn?.pool.end();
    await withAdmin(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }).catch(() => {
      // Best effort cleanup of a throwaway database.
    });
  }, 60_000);

  const csv = [
    "url,title,platform,published_at,tags,author",
    'https://dev.to/ada/pg-post,Postgres notes,devto,2026-09-01,"Postgres, SQL",Ada',
    "https://ada.example.com/essay,An essay,,2026-09-05,thoughts,Ada Lovelace",
  ].join("\n");

  it("imports a CSV, detects the blank platform, and is idempotent", async () => {
    const first = await importContent(conn, { csv });
    expect(first).toMatchObject({ items: 2, created: 2, existing: 0 });
    expect(first.errors).toEqual([]);

    const essay = await resolveContentRef(
      conn,
      "https://ada.example.com/essay",
    );
    expect(essay.platform).toBe("blog");
    expect(essay.tags).toEqual(["thoughts"]);

    const second = await importContent(conn, { csv });
    expect(second).toMatchObject({ items: 2, created: 0, existing: 2 });
  });

  it("round-trips tags and payloads through Postgres text columns", async () => {
    const post = await resolveContentRef(conn, "https://dev.to/ada/pg-post");
    // JSON-as-text on Postgres reads back as the same array SQLite gives.
    expect(post.tags).toEqual(["Postgres", "SQL"]);

    await recordMetrics(
      conn,
      {
        contentId: post.id,
        views: 100,
        likes: 9,
        fetchedAt: "2026-09-02",
        source: "devto_api",
        rawPayload: { page_views: 100, public_reactions_count: 9 },
      },
      { now },
    );
    const series = await getContentMetricsSeries(conn, post.id);
    expect(series!.metrics[0]).toMatchObject({
      views: 100,
      likes: 9,
      rawPayload: { page_views: 100, public_reactions_count: 9 },
    });
  });

  it("lists with platform/tag/days/query filters, LIKE escaping and pagination", async () => {
    await addContentItem(
      conn,
      {
        url: "https://ada.example.com/100%-sure",
        title: "100% Sure",
        publishedAt: "2026-09-07",
      },
      { now },
    );

    const all = await listContentItems(conn, {});
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.title)).toEqual([
      "100% Sure",
      "An essay",
      "Postgres notes",
    ]);

    // Tag match is case-insensitive on both dialects (lower() both sides).
    expect((await listContentItems(conn, { tag: "postgres" })).total).toBe(1);
    expect((await listContentItems(conn, { tag: "POSTGRES" })).total).toBe(1);
    // …and a quoted element, not a substring: "sql" must not match "mysql".
    expect((await listContentItems(conn, { tag: "sql" })).total).toBe(1);
    expect((await listContentItems(conn, { tag: "my" })).total).toBe(0);

    // `%` in a query is a literal, not a wildcard.
    expect(
      (await listContentItems(conn, { query: "100%" })).items.map(
        (i) => i.title,
      ),
    ).toEqual(["100% Sure"]);

    const windowed = await listContentItems(conn, { days: 5, now });
    expect(windowed.items.map((i) => i.title)).toEqual([
      "100% Sure",
      "An essay",
    ]);

    const page = await listContentItems(conn, { limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it("aggregates the overview over latest snapshots only", async () => {
    const post = await resolveContentRef(conn, "https://dev.to/ada/pg-post");
    await recordMetrics(
      conn,
      { contentId: post.id, views: 150, fetchedAt: "2026-09-03" },
      { now },
    );

    const overview = await getContentOverview(conn, { now });
    expect(overview).toMatchObject({
      items: 3,
      withMetrics: 1,
      snapshots: 2,
      totalViews: 150,
    });
    expect(overview.top.map((t) => t.title)).toEqual(["Postgres notes"]);
    expect(overview.byPlatform).toEqual([
      { platform: "devto", items: 1, views: 150 },
      { platform: "blog", items: 2, views: 0 },
    ]);

    const windowed = await getContentOverview(conn, { days: 5, now });
    expect(windowed).toMatchObject({
      items: 2,
      totalViews: 0,
      excludedUndated: 0,
    });
  });

  it("links mentions, hides soft-deleted contacts, and lists per-contact content", async () => {
    const post = await resolveContentRef(conn, "https://dev.to/ada/pg-post");
    await addContentMention(conn, {
      contentId: post.id,
      contactId: "a",
      context: "co-authored",
    });
    await addContentMention(conn, { contentId: post.id, contactId: "b" });

    // The soft-deleted contact cannot be linked at all.
    await expect(
      addContentMention(conn, { contentId: post.id, contactId: "gone" }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(await listContentMentions(conn, post.id)).toEqual([
      expect.objectContaining({ contactId: "a", context: "co-authored" }),
      expect.objectContaining({ contactId: "b", context: null }),
    ]);
    expect((await listContactContent(conn, "a")).map((i) => i.title)).toEqual([
      "Postgres notes",
    ]);
    expect((await getContentItem(conn, post.id))!.mentionsCount).toBe(2);
  });

  it("reports status and deletes an item with its children", async () => {
    const before = await contentStatus(conn);
    expect(before).toMatchObject({
      items: 3,
      withMetrics: 1,
      snapshots: 2,
      mentions: 2,
    });

    const target = await resolveContentRef(conn, "https://dev.to/ada/pg-post");
    await deleteContentItem(conn, target.id);
    expect((await listContentItems(conn, { query: "postgres" })).total).toBe(0);

    const after = await contentStatus(conn);
    expect(after).toMatchObject({
      items: 2,
      withMetrics: 0,
      snapshots: 0,
      mentions: 0,
    });
  });
});
