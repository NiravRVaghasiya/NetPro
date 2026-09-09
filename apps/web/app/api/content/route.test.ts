import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    role: "owner",
    userId: "system",
  }),
}));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET, POST } from "./route";

const NOW = new Date("2026-09-07T12:00:00.000Z");

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
});
afterAll(() => fixture.sqlite.close());

async function seedItem(
  url: string,
  title: string,
  extra: { platform?: string; publishedAt?: string; tags?: string[] } = {},
): Promise<string> {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url,
      title,
      platform: extra.platform,
      publishedAt: extra.publishedAt,
      tags: extra.tags,
      source: "manual",
    },
    { now: NOW },
  );
  return item.id;
}

const get = (qs = "") => GET(new Request(`http://localhost/api/content${qs}`));
const postJson = (body: unknown, qs = "") =>
  POST(
    new Request(`http://localhost/api/content${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

function postFile(
  body: string,
  name = "content.csv",
  qs = "",
): Promise<Response> {
  const form = new FormData();
  const kind =
    name.endsWith(".xml") || name.endsWith(".rss") || name.endsWith(".atom")
      ? "application/xml"
      : "text/csv";
  form.append("file", new File([body], name, { type: kind }));
  return POST(
    new Request(`http://localhost/api/content${qs}`, {
      method: "POST",
      body: form,
    }),
  );
}

const CSV = [
  "url,title,platform,published_at",
  "https://example.dev/blog/hello,Hello world,blog,2026-09-01",
  "https://dev.to/ada/trick,Trick for you,devto,2026-08-20",
].join("\n");

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Ada's blog</title>
<item><title>From the feed</title><link>https://example.dev/feed-post</link>
<pubDate>Mon, 01 Sep 2026 09:00:00 +0000</pubDate></item>
</channel></rss>`;

interface ListBody {
  items: Array<{
    id: string;
    title: string;
    platform: string;
    latestMetrics: { views: number } | null;
    metricsCount: number;
  }>;
  total: number;
  limit: number;
  offset: number;
}

describe("GET /api/content", () => {
  it("lists content newest-first with the latest snapshot attached", async () => {
    const { recordMetrics } = await import("@netpro/core/src/content");
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {
      publishedAt: "2026-09-01",
    });
    await recordMetrics(
      fixture.conn,
      { contentId: id, views: 1200, likes: 40 },
      { now: NOW },
    );
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      title: "Blog one",
      latestMetrics: { views: 1200 },
      metricsCount: 1,
    });
  });

  it("filters by platform, tag, days and query, and clamps pagination", async () => {
    // `days` is a rolling window against the real clock, so seed relative to
    // "now": one post half a day old, one three days old.
    const halfDayAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await seedItem("https://example.dev/blog/one", "Blog one", {
      platform: "blog",
      publishedAt: halfDayAgo,
      tags: ["js"],
    });
    await seedItem("https://dev.to/ada/two", "Devto two", {
      platform: "devto",
      publishedAt: threeDaysAgo,
      tags: ["rust"],
    });
    const byPlatform = (await (
      await get("?platform=devto")
    ).json()) as ListBody;
    expect(byPlatform.items.map((i) => i.title)).toEqual(["Devto two"]);
    const byTag = (await (await get("?tag=js")).json()) as ListBody;
    expect(byTag.items.map((i) => i.title)).toEqual(["Blog one"]);
    const byDays = (await (await get("?days=1")).json()) as ListBody;
    expect(byDays.items.map((i) => i.title)).toEqual(["Blog one"]);
    const byQuery = (await (await get("?query=two")).json()) as ListBody;
    expect(byQuery.items.map((i) => i.title)).toEqual(["Devto two"]);
    const clamped = (await (
      await get("?limit=abc&offset=-4&days=999")
    ).json()) as ListBody;
    expect(clamped.limit).toBe(50);
    expect(clamped.offset).toBe(0);
    expect(clamped.items.length).toBeLessThanOrEqual(2);
  });

  it("rejects an unknown platform with 400 naming the whitelist", async () => {
    const res = await get("?platform=myspace");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'Unknown platform "myspace"',
    );
  });

  it("rejects an over-long query with 400", async () => {
    const res = await get(`?query=${"x".repeat(201)}`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/content — create one", () => {
  it("creates an item (201) and reports duplicates as already tracked", async () => {
    const first = await postJson({
      url: "https://example.dev/blog/one?utm_source=web",
      title: "Blog one",
      platform: "blog",
      publishedAt: "2026-09-01",
      tags: ["js", "web"],
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      created: boolean;
      item: { id: string; title: string };
    };
    expect(created.created).toBe(true);

    const second = await postJson({
      url: "https://example.dev/blog/one",
      title: "Renamed",
    });
    expect(second.status).toBe(201);
    const dup = (await second.json()) as {
      created: boolean;
      item: { title: string };
    };
    expect(dup.created).toBe(false);
    // Idempotent: the existing row wins, the new title does not overwrite it.
    expect(dup.item.title).toBe("Blog one");
  });

  it("rejects bad payloads with 400s", async () => {
    const noUrl = await postJson({ title: "No URL" });
    expect(noUrl.status).toBe(400);
    expect(((await noUrl.json()) as { error: string }).error).toMatch(/url/i);
    const badUrl = await postJson({ url: "javascript:alert(1)", title: "X" });
    expect(badUrl.status).toBe(400);
    const badPlatform = await postJson({
      url: "https://example.dev/x",
      title: "X",
      platform: "myspace",
    });
    expect(badPlatform.status).toBe(400);
    const badDate = await postJson({
      url: "https://example.dev/x",
      title: "X",
      publishedAt: "whenever",
    });
    expect(badDate.status).toBe(400);
    expect(((await badDate.json()) as { error: string }).error).toContain(
      "not a date",
    );
  });

  it("rejects a non-JSON body with 415", async () => {
    const res = await POST(
      new Request("http://localhost/api/content", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "csv",
      }),
    );
    expect(res.status).toBe(415);
  });
});

describe("POST /api/content — import", () => {
  it("imports JSON CSV idempotently and reports created vs existing", async () => {
    const first = await postJson({ csv: CSV });
    expect(first.status).toBe(201);
    const summary = (await first.json()) as {
      items: number;
      created: number;
      existing: number;
    };
    expect(summary).toMatchObject({ items: 2, created: 2, existing: 0 });

    const second = (await (await postJson({ csv: CSV })).json()) as {
      items: number;
      created: number;
      existing: number;
    };
    expect(second).toMatchObject({ items: 2, created: 0, existing: 2 });
  });

  it("imports a feed XML body", async () => {
    const res = await postJson({ feedXml: FEED });
    expect(res.status).toBe(201);
    const summary = (await res.json()) as {
      feed: { title: string } | null;
      created: number;
    };
    expect(summary.feed?.title).toBe("Ada's blog");
    expect(summary.created).toBe(1);
  });

  it("previews with ?dryRun=1 and writes nothing", async () => {
    const preview = (await (
      await postJson({ csv: CSV }, "?dryRun=1")
    ).json()) as {
      dryRun: boolean;
      created: number;
    };
    expect(preview).toMatchObject({ dryRun: true, created: 2 });
    const list = (await (await get("")).json()) as ListBody;
    expect(list.total).toBe(0);
  });

  it("accepts a multipart CSV file", async () => {
    const res = await postFile(CSV);
    expect(res.status).toBe(201);
    const summary = (await res.json()) as { items: number };
    expect(summary.items).toBe(2);
  });

  it("rejects sending csv and feedXml together", async () => {
    const res = await postJson({ csv: CSV, feedXml: FEED });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "exactly one",
    );
  });
});
