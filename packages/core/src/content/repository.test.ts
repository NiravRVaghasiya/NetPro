import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import { ContentError } from "./types";
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
  removeContentMention,
  resolveContentRef,
  upsertContentItem,
} from "./index";

const fixture = createTestSqliteConn();
const conn = fixture.conn;
const now = new Date("2026-09-08T12:00:00Z");
const NOW = now.toISOString();

function seedContacts(): void {
  for (const c of [
    { id: "a", fullName: "Ada Lovelace", email: "ada@engines.dev" },
    { id: "b", fullName: "Bob Builder", email: "bob@builders.io" },
    {
      id: "gone",
      fullName: "Ghost",
      email: "ghost@example.com",
      deletedAt: NOW,
    },
  ]) {
    conn.db
      .insert(conn.schema.contacts)
      .values({
        id: c.id,
        fullName: c.fullName,
        email: c.email,
        source: "test",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: "deletedAt" in c ? c.deletedAt : null,
      })
      .run();
  }
}

function reset(): void {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
}

beforeEach(() => {
  reset();
  seedContacts();
});
afterAll(() => fixture.sqlite.close());

const item = (overrides: Record<string, unknown> = {}) => ({
  url: "https://ada.example.com/hello",
  title: "Hello",
  ...overrides,
});

describe("addContentItem / upsertContentItem", () => {
  it("creates an item with detected platform and manual source", async () => {
    const created = await addContentItem(conn, item(), { now });
    expect(created).toMatchObject({
      url: "https://ada.example.com/hello",
      urlNorm: "https://ada.example.com/hello",
      title: "Hello",
      platform: "blog",
      type: null,
      publishedAt: null,
      author: null,
      tags: [],
      summary: null,
      source: "manual",
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBe(NOW);
  });

  it("detects the platform from the host and keeps the original URL", async () => {
    const created = await addContentItem(
      conn,
      item({ url: "https://DEV.to/ada/post?utm_source=x", title: "On feeds" }),
      { now },
    );
    expect(created.platform).toBe("devto");
    expect(created.url).toBe("https://DEV.to/ada/post?utm_source=x");
    expect(created.urlNorm).toBe("https://dev.to/ada/post");
  });

  it("round-trips tags, dates, authors and summaries", async () => {
    const created = await addContentItem(
      conn,
      item({
        type: "article",
        publishedAt: "2026-09-01",
        author: "Ada",
        tags: ["js", "rust"],
        summary: "An essay.",
        source: "rss",
      }),
      { now },
    );
    expect(created).toMatchObject({
      type: "article",
      publishedAt: "2026-09-01T00:00:00.000Z",
      author: "Ada",
      tags: ["js", "rust"],
      summary: "An essay.",
      source: "rss",
    });
    // And back out of the database identical (JSON columns included).
    expect(await getContentItem(conn, created.id)).toMatchObject({
      tags: ["js", "rust"],
      publishedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("add is strict (conflict) while upsert is idempotent (existing, unchanged)", async () => {
    const first = await addContentItem(conn, item(), { now });
    await expect(
      addContentItem(conn, item({ title: "Other" }), { now }),
    ).rejects.toMatchObject({
      name: "ContentError",
      code: "conflict",
    });
    // Even with tracking junk on the URL: same normalized key, same row.
    const second = await upsertContentItem(
      conn,
      item({
        url: "https://ada.example.com/hello?utm_source=x",
        title: "Other",
      }),
      { now },
    );
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.id);
    expect(second.item.title).toBe("Hello");
  });

  it("validates every field with the house error", async () => {
    await expect(
      addContentItem(conn, item({ url: "not a url" }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(conn, item({ title: "" }), { now }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      addContentItem(conn, item({ platform: "tiktok" }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(conn, item({ type: "hot-take" }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(conn, item({ publishedAt: "2026-02-31" }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(conn, item({ tags: ["ok", 42] }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(conn, item({ source: "scrape" }), { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addContentItem(
        conn,
        item({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
        { now },
      ),
    ).rejects.toThrow(/at most 20/);
  });
});

describe("listContentItems / resolveContentRef / getContentItem", () => {
  async function seedLibrary(): Promise<void> {
    await addContentItem(
      conn,
      item({
        url: "https://dev.to/ada/a",
        title: "Dev A",
        tags: ["js"],
        publishedAt: "2026-09-01",
      }),
      { now },
    );
    await addContentItem(
      conn,
      item({
        url: "https://ada.example.com/b",
        title: "Blog B",
        tags: ["JS"],
        publishedAt: "2026-09-05",
        author: "Ada Lovelace",
      }),
      { now },
    );
    await addContentItem(
      conn,
      item({ url: "https://x.com/ada/status/1", title: "Hot take" }),
      {
        now,
      },
    );
  }

  it("orders newest-published first with undated last, and pages", async () => {
    await seedLibrary();
    const all = await listContentItems(conn, {});
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.title)).toEqual([
      "Blog B",
      "Dev A",
      "Hot take",
    ]);
    const page = await listContentItems(conn, { limit: 1, offset: 1 });
    expect(page.items.map((i) => i.title)).toEqual(["Dev A"]);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
  });

  it("filters by platform, tag (case-insensitive), days and query", async () => {
    await seedLibrary();
    expect(
      (await listContentItems(conn, { platform: "devto" })).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Dev A"]);
    // `js` matches both `js` and `JS` on either dialect.
    expect((await listContentItems(conn, { tag: "js" })).total).toBe(2);
    expect((await listContentItems(conn, { tag: "rust" })).total).toBe(0);
    // `100%` is a literal, not a wildcard.
    expect((await listContentItems(conn, { query: "100%" })).total).toBe(0);
    expect(
      (await listContentItems(conn, { query: "lovelace" })).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Blog B"]);
    // Days count back from now: 2026-09-05 is in, 2026-09-01 and undated are out.
    expect(
      (await listContentItems(conn, { days: 5, now })).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Blog B"]);
    await expect(
      listContentItems(conn, { platform: "tiktok" }),
    ).rejects.toThrow(ContentError);
    await expect(listContentItems(conn, { days: -1 })).rejects.toThrow(
      ContentError,
    );
  });

  it("resolves ids and URLs (tracking junk tolerated), else not_found", async () => {
    const created = await addContentItem(conn, item(), { now });
    expect((await resolveContentRef(conn, created.id)).title).toBe("Hello");
    expect(
      (
        await resolveContentRef(
          conn,
          "https://ada.example.com/hello?utm_source=x#top",
        )
      ).id,
    ).toBe(created.id);
    await expect(resolveContentRef(conn, "missing")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      resolveContentRef(conn, "https://ada.example.com/other"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveContentRef(conn, "   ")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("getContentItem returns the detail payload or null", async () => {
    const created = await addContentItem(conn, item(), { now });
    await recordMetrics(conn, { contentId: created.id, views: 10 }, { now });
    await addContentMention(conn, { contentId: created.id, contactId: "a" });
    expect(await getContentItem(conn, created.id)).toMatchObject({
      title: "Hello",
      latestMetrics: { views: 10 },
      metricsCount: 1,
      mentionsCount: 1,
    });
    expect(await getContentItem(conn, "missing")).toBe(null);
  });
});

describe("deleteContentItem", () => {
  it("removes the item with its metrics and mentions, explicitly", async () => {
    const created = await addContentItem(conn, item(), { now });
    await recordMetrics(conn, { contentId: created.id, views: 1 }, { now });
    await addContentMention(conn, { contentId: created.id, contactId: "a" });
    const removed = await deleteContentItem(conn, created.id);
    expect(removed.id).toBe(created.id);
    expect(await getContentItem(conn, created.id)).toBe(null);
    expect((await contentStatus(conn)).snapshots).toBe(0);
    expect((await contentStatus(conn)).mentions).toBe(0);
    await expect(deleteContentItem(conn, created.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("recordMetrics / getContentMetricsSeries", () => {
  it("appends snapshots with defaults and reads the series oldest-first", async () => {
    const created = await addContentItem(conn, item(), { now });
    const first = await recordMetrics(
      conn,
      { contentId: created.id, views: 10, likes: 2 },
      { now },
    );
    expect(first).toMatchObject({
      contentId: created.id,
      fetchedAt: NOW,
      source: "manual",
      views: 10,
      likes: 2,
      comments: null,
      rawPayload: null,
    });
    await recordMetrics(
      conn,
      {
        contentId: created.id,
        views: 25,
        fetchedAt: "2026-09-07",
        source: "devto_api",
        rawPayload: { page_views: 25 },
      },
      { now },
    );
    const series = await getContentMetricsSeries(conn, created.id);
    expect(series!.total).toBe(2);
    expect(series!.metrics.map((m) => m.views)).toEqual([25, 10]);
    expect(series!.latest).toMatchObject({ views: 10, rawPayload: null });
    // The raw payload survives the JSON round-trip.
    expect(series!.metrics[0]).toMatchObject({
      rawPayload: { page_views: 25 },
    });
  });

  it("filters the series by days and caps the length", async () => {
    const created = await addContentItem(conn, item(), { now });
    await recordMetrics(
      conn,
      { contentId: created.id, views: 1, fetchedAt: "2026-01-01" },
      { now },
    );
    await recordMetrics(
      conn,
      { contentId: created.id, views: 2, fetchedAt: "2026-09-08" },
      { now },
    );
    const windowed = await getContentMetricsSeries(conn, created.id, {
      days: 30,
      now,
    });
    expect(windowed!.metrics.map((m) => m.views)).toEqual([2]);
    expect(windowed!.total).toBe(1);
    const capped = await getContentMetricsSeries(conn, created.id, {
      limit: 1,
    });
    expect(capped!.metrics).toHaveLength(1);
    expect(capped!.total).toBe(2);
    expect(await getContentMetricsSeries(conn, "missing")).toBe(null);
  });

  it("rejects empty, negative, fractional and unserializable snapshots", async () => {
    const created = await addContentItem(conn, item(), { now });
    await expect(
      recordMetrics(conn, { contentId: created.id }, { now }),
    ).rejects.toThrow(/At least one metric/);
    await expect(
      recordMetrics(conn, { contentId: created.id, views: -1 }, { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      recordMetrics(conn, { contentId: created.id, views: 1.5 }, { now }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      recordMetrics(
        conn,
        { contentId: created.id, views: 1, fetchedAt: "someday" },
        { now },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      recordMetrics(
        conn,
        { contentId: created.id, views: 1, source: "scrape" },
        { now },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      recordMetrics(
        conn,
        { contentId: created.id, views: 1, rawPayload: circular },
        { now },
      ),
    ).rejects.toThrow(/JSON-serializable/);
    await expect(
      recordMetrics(conn, { contentId: "missing", views: 1 }, { now }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("getContentOverview", () => {
  it("aggregates totals, top 5 and platform breakdown over latest snapshots", async () => {
    const a = await addContentItem(
      conn,
      item({
        url: "https://dev.to/ada/a",
        title: "A",
        publishedAt: "2026-09-01",
      }),
      { now },
    );
    const b = await addContentItem(
      conn,
      item({
        url: "https://ada.example.com/b",
        title: "B",
        publishedAt: "2026-09-02",
      }),
      { now },
    );
    await addContentItem(
      conn,
      item({ url: "https://ada.example.com/c", title: "C" }),
      { now },
    );
    // Two snapshots for A: only the latest counts toward totals.
    await recordMetrics(
      conn,
      { contentId: a.id, views: 100, fetchedAt: "2026-09-02" },
      { now },
    );
    await recordMetrics(
      conn,
      { contentId: a.id, views: 150, likes: 9, fetchedAt: "2026-09-03" },
      { now },
    );
    await recordMetrics(
      conn,
      { contentId: b.id, likes: 4, fetchedAt: "2026-09-03" },
      { now },
    );

    const overview = await getContentOverview(conn, { now });
    expect(overview).toMatchObject({
      days: null,
      items: 3,
      withMetrics: 2,
      snapshots: 3,
      excludedUndated: 0,
      // 150 from A; B reported likes but no views, so it contributes nothing.
      totalViews: 150,
    });
    expect(overview.top.map((t) => t.title)).toEqual(["A"]);
    expect(overview.top[0]).toMatchObject({
      metricsCount: 2,
      mentionsCount: 0,
    });
    expect(overview.byPlatform).toEqual([
      { platform: "devto", items: 1, views: 150 },
      { platform: "blog", items: 2, views: 0 },
    ]);
  });

  it("windows by publish date and says how many undated items it skipped", async () => {
    await addContentItem(
      conn,
      item({
        url: "https://ada.example.com/new",
        title: "New",
        publishedAt: "2026-09-07",
      }),
      { now },
    );
    await addContentItem(
      conn,
      item({
        url: "https://ada.example.com/old",
        title: "Old",
        publishedAt: "2026-01-01",
      }),
      { now },
    );
    await addContentItem(
      conn,
      item({ url: "https://ada.example.com/undated", title: "Undated" }),
      {
        now,
      },
    );
    const overview = await getContentOverview(conn, { days: 30, now });
    expect(overview).toMatchObject({ days: 30, items: 1, excludedUndated: 1 });
    expect(overview.top).toEqual([]);
    expect(overview.byPlatform).toEqual([
      { platform: "blog", items: 1, views: 0 },
    ]);
  });

  it("is zeroes on an empty library", async () => {
    expect(await getContentOverview(conn, { now })).toMatchObject({
      items: 0,
      withMetrics: 0,
      snapshots: 0,
      totalViews: 0,
      top: [],
      byPlatform: [],
    });
  });
});

describe("importContent", () => {
  const csv = [
    "url,title,platform,published_at,tags",
    'https://example.com/a,A post,blog,2026-09-01,"js, rust"',
    "https://dev.to/ada/b,B post,,2026-09-02,",
  ].join("\n");

  it("imports a CSV and is idempotent on re-import", async () => {
    const first = await importContent(conn, { csv });
    expect(first).toMatchObject({
      items: 2,
      created: 2,
      existing: 0,
      dryRun: false,
    });
    expect(first.errors).toEqual([]);
    expect((await listContentItems(conn, {})).total).toBe(2);
    // Per-link platform detection filled the blank cell.
    expect(
      (await resolveContentRef(conn, "https://dev.to/ada/b")).platform,
    ).toBe("devto");

    const second = await importContent(conn, { csv });
    expect(second).toMatchObject({ items: 2, created: 0, existing: 2 });
    expect((await listContentItems(conn, {})).total).toBe(2);
  });

  it("imports a feed body with its feed header in the summary", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>My Blog</title><link>https://example.com</link>
      <item><title>A</title><link>https://example.com/a</link><pubDate>Mon, 14 Sep 2026 09:30:00 GMT</pubDate></item>
    </channel></rss>`;
    const summary = await importContent(conn, { feedXml: xml });
    expect(summary).toMatchObject({
      items: 1,
      created: 1,
      feed: { title: "My Blog", link: "https://example.com" },
    });
    expect(
      (await resolveContentRef(conn, "https://example.com/a")).platform,
    ).toBe("rss");
  });

  it("dry-runs without writing and honors overrides", async () => {
    const dry = await importContent(conn, {
      csv,
      dryRun: true,
      platform: "blog",
      source: "rss",
    });
    expect(dry).toMatchObject({
      items: 2,
      created: 2,
      existing: 0,
      dryRun: true,
    });
    expect((await listContentItems(conn, {})).total).toBe(0);

    await importContent(conn, { csv, platform: "blog", source: "rss" });
    const item = await resolveContentRef(conn, "https://dev.to/ada/b");
    expect(item).toMatchObject({ platform: "blog", source: "rss" });
  });

  it("carries parse errors and warnings into the summary", async () => {
    const bad = ["url,title", "https://example.com/ok,Ok", ",Missing URL"].join(
      "\n",
    );
    const summary = await importContent(conn, { csv: bad });
    expect(summary).toMatchObject({ items: 1, created: 1 });
    expect(summary.errors).toHaveLength(1);
  });

  it("requires exactly one input", async () => {
    await expect(importContent(conn, {})).rejects.toThrow(/Exactly one/);
    await expect(
      importContent(conn, { csv, feedXml: "<rss/>" }),
    ).rejects.toThrow(/Exactly one/);
    await expect(
      importContent(conn, { csv, platform: "tiktok" }),
    ).rejects.toThrow(/Unknown platform/);
  });
});

describe("mentions", () => {
  it("links, re-links (updating context), lists and unlinks", async () => {
    const created = await addContentItem(conn, item(), { now });
    const first = await addContentMention(conn, {
      contentId: created.id,
      contactId: "b",
      context: "mentioned",
    });
    expect(first).toMatchObject({
      created: true,
      mention: {
        contentId: created.id,
        contactId: "b",
        fullName: "Bob Builder",
        context: "mentioned",
      },
    });
    await addContentMention(conn, { contentId: created.id, contactId: "a" });

    const again = await addContentMention(conn, {
      contentId: created.id,
      contactId: "b",
      context: "co-authored",
    });
    expect(again.created).toBe(false);
    expect(again.mention.context).toBe("co-authored");

    expect(await listContentMentions(conn, created.id)).toEqual([
      expect.objectContaining({
        contactId: "a",
        fullName: "Ada Lovelace",
        context: null,
      }),
      expect.objectContaining({ contactId: "b", context: "co-authored" }),
    ]);
    expect(await listContactContent(conn, "a")).toHaveLength(1);

    expect(
      await removeContentMention(conn, {
        contentId: created.id,
        contactId: "b",
      }),
    ).toMatchObject({ removed: true });
    expect(
      await removeContentMention(conn, {
        contentId: created.id,
        contactId: "b",
      }),
    ).toMatchObject({ removed: false });
    expect(await listContentMentions(conn, created.id)).toHaveLength(1);
  });

  it("never surfaces soft-deleted contacts and rejects bad links", async () => {
    const created = await addContentItem(conn, item(), { now });
    await expect(
      addContentMention(conn, { contentId: created.id, contactId: "gone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      addContentMention(conn, { contentId: "missing", contactId: "a" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      addContentMention(conn, { contentId: created.id, contactId: "missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
    // A mention whose contact is deleted afterwards reads as gone.
    await addContentMention(conn, { contentId: created.id, contactId: "a" });
    fixture.sqlite
      .prepare("UPDATE contacts SET deleted_at = ? WHERE id = ?")
      .run(NOW, "a");
    expect(await listContentMentions(conn, created.id)).toEqual([]);
    // Raw row still there (the delete is soft), but every read path excludes it.
    expect((await contentStatus(conn)).mentions).toBe(0);
  });
});

describe("contentStatus", () => {
  it("counts items, measured items, snapshots and live mentions", async () => {
    expect(await contentStatus(conn)).toEqual({
      items: 0,
      withMetrics: 0,
      snapshots: 0,
      mentions: 0,
    });
    const created = await addContentItem(conn, item(), { now });
    await addContentItem(
      conn,
      item({ url: "https://example.com/other", title: "Other" }),
      { now },
    );
    await recordMetrics(conn, { contentId: created.id, views: 1 }, { now });
    await recordMetrics(conn, { contentId: created.id, views: 2 }, { now });
    await addContentMention(conn, { contentId: created.id, contactId: "a" });
    expect(await contentStatus(conn)).toEqual({
      items: 2,
      withMetrics: 1,
      snapshots: 2,
      mentions: 1,
    });
  });
});
