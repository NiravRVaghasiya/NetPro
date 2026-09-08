import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeContentAdd,
  executeContentAnalyze,
  executeContentFetch,
  executeContentImport,
  executeContentList,
  executeContentRm,
  executeContentShow,
  renderImportSummary,
  renderItemDetail,
  renderOverview,
} from "./content";
import { createProgram } from "../cli";

const fixture = createTestSqliteConn();
const conn = fixture.conn;
const now = new Date("2026-09-07T12:00:00Z");
const NOW = now.toISOString();

const dir = join(tmpdir(), `netpro-content-test-${process.pid}`);
mkdirSync(dir, { recursive: true });
const filePath = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  return path;
};

const CONTENT_CSV = [
  "url,title,platform,published_at,tags",
  'https://example.dev/blog/hello,Hello world,blog,2026-09-01,"js,web"',
  "https://dev.to/ada/trick,Trick for you,devto,2026-08-20,",
].join("\n");

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Ada's blog</title><link>https://example.dev/</link>
  <item>
    <title>Feed post</title>
    <link>https://example.dev/blog/from-feed</link>
    <pubDate>Mon, 01 Sep 2026 09:00:00 +0000</pubDate>
    <category>rss</category>
  </item>
</channel></rss>`;

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  const rows = [
    {
      id: "a",
      fullName: "Ada Lovelace",
      email: "ada@engines.dev",
      relationshipScore: 0.9,
    },
    {
      id: "b",
      fullName: "Bob Builder",
      email: "bob@builders.io",
      relationshipScore: 0.6,
    },
    {
      id: "gone",
      fullName: "Ghost",
      email: "ghost@example.com",
      deletedAt: NOW,
    },
  ];
  for (const r of rows) {
    conn.db
      .insert(conn.schema.contacts)
      .values({ ...r, source: "test", createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

async function seedItem(
  url: string,
  title: string,
  extra: { platform?: string; publishedAt?: string; tags?: string[] } = {},
): Promise<string> {
  const { item } = await executeContentAddRaw(url, title, extra);
  return item.id;
}

async function executeContentAddRaw(
  url: string,
  title: string,
  extra: { platform?: string; publishedAt?: string; tags?: string[] } = {},
) {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  return upsertContentItem(
    conn,
    {
      url,
      title,
      platform: extra.platform,
      publishedAt: extra.publishedAt,
      tags: extra.tags,
    },
    { now },
  );
}

describe("netpro content registration", () => {
  it("is the eighteenth command with the documented subcommands", () => {
    const program = createProgram();
    expect(program.commands.map((c) => c.name())).toContain("content");
    const content = program.commands.find((c) => c.name() === "content")!;
    expect(content.commands.map((c) => c.name())).toEqual([
      "list",
      "add",
      "show",
      "import",
      "fetch",
      "rm",
      "analyze",
    ]);
  });
});

describe("content list", () => {
  it("has an empty state with next steps", async () => {
    const out = await executeContentList({}, conn, now);
    expect(out).toContain("No content tracked yet");
    expect(out).toContain("netpro content add");
  });

  it("renders rows newest-first with platform, date and id", async () => {
    const older = await seedItem("https://example.dev/blog/one", "Older post", {
      publishedAt: "2026-08-01",
    });
    const newer = await seedItem("https://example.dev/blog/two", "Newer post", {
      publishedAt: "2026-09-05",
    });
    const out = await executeContentList({}, conn, now);
    expect(out.indexOf("Newer post")).toBeLessThan(out.indexOf("Older post"));
    expect(out).toContain(
      `Newer post · 2026-09-05 (2d ago) · blog  [${newer.slice(0, 8)}]`,
    );
    expect(out).toContain(`[${older.slice(0, 8)}]`);
    expect(out).toContain(
      "2 tracked · 0 with metrics · 0 snapshot(s) · 0 mention(s)",
    );
  });

  it("keeps undated items visible (no hidden window by default)", async () => {
    await seedItem("https://example.dev/blog/undated", "No date", {});
    const out = await executeContentList({}, conn, now);
    expect(out).toContain("No date");
    expect(out).toContain("no date");
  });

  it("filters by platform, tag, days and query", async () => {
    await seedItem("https://example.dev/blog/one", "Blog one", {
      platform: "blog",
      publishedAt: "2026-09-07",
      tags: ["js"],
    });
    await seedItem("https://dev.to/ada/two", "Devto two", {
      platform: "devto",
      publishedAt: "2026-09-02",
      tags: ["rust"],
    });
    const byPlatform = await executeContentList(
      { platform: "devto" },
      conn,
      now,
    );
    expect(byPlatform).toContain("Devto two");
    expect(byPlatform).not.toContain("Blog one");
    const byTag = await executeContentList({ tag: "js" }, conn, now);
    expect(byTag).toContain("Blog one");
    expect(byTag).not.toContain("Devto two");
    // `--days 1` is a rolling window: only today's post stays inside it.
    const byDays = await executeContentList({ days: "1" }, conn, now);
    expect(byDays).toContain("Blog one");
    expect(byDays).not.toContain("Devto two");
    const byQuery = await executeContentList({ query: "one" }, conn, now);
    expect(byQuery).toContain("Blog one");
    expect(byQuery).not.toContain("Devto two");
  });

  it("rejects an unknown platform instead of widening the result", async () => {
    await expect(
      executeContentList({ platform: "myspace" }, conn, now),
    ).rejects.toThrow(/Unknown platform "myspace"/);
  });

  it("prints JSON with items, total and limit", async () => {
    await seedItem("https://example.dev/blog/one", "Blog one", {
      publishedAt: "2026-09-01",
    });
    const raw = await executeContentList({ json: true }, conn, now);
    const parsed = JSON.parse(raw) as {
      total: number;
      limit: number;
      items: Array<{ title: string }>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(50);
    expect(parsed.items[0]?.title).toBe("Blog one");
  });

  it("rejects a garbage limit", async () => {
    await expect(
      executeContentList({ limit: "abc" }, conn, now),
    ).rejects.toThrow("--limit");
  });
});

describe("content add", () => {
  it("adds a piece of content and detects the platform from the host", async () => {
    const out = await executeContentAdd(
      "https://dev.to/ada/hello",
      { title: "Hello" },
      conn,
      now,
    );
    expect(out).toContain('✓ Added "Hello" (devto');
    const list = await executeContentList({}, conn, now);
    expect(list).toContain("Hello");
  });

  it("is idempotent — a repeat add reports the existing row unchanged", async () => {
    await executeContentAdd(
      "https://example.dev/post?utm_source=x",
      { title: "First" },
      conn,
      now,
    );
    const second = await executeContentAdd(
      "https://example.dev/post?utm_source=y",
      { title: "Second" },
      conn,
      now,
    );
    expect(second).toContain("already tracked");
    expect(second).toContain("First");
    const list = await executeContentList({ json: true }, conn, now);
    expect((JSON.parse(list) as { total: number }).total).toBe(1);
  });

  it("requires --title", async () => {
    await expect(
      executeContentAdd("https://example.dev/x", {}, conn, now),
    ).rejects.toThrow("--title is required");
  });

  it("rejects a bad URL, unknown platform and unreadable date with the core errors", async () => {
    await expect(
      executeContentAdd("javascript:alert(1)", { title: "X" }, conn, now),
    ).rejects.toThrow(/URL|http/);
    await expect(
      executeContentAdd(
        "https://example.dev/x",
        { title: "X", platform: "myspace" },
        conn,
        now,
      ),
    ).rejects.toThrow(/Unknown platform "myspace"/);
    await expect(
      executeContentAdd(
        "https://example.dev/x",
        { title: "X", publishedAt: "whenever" },
        conn,
        now,
      ),
    ).rejects.toThrow(/not a date/);
  });
});

describe("content show", () => {
  it("renders the detail with latest snapshot and counts", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {
      publishedAt: "2026-09-01",
      tags: ["js"],
    });
    await executeContentFetch(
      id,
      { manual: true, views: "1200", likes: "35" },
      conn,
      now,
    );
    const out = await executeContentShow(id, {}, conn, now);
    expect(out).toContain("Blog one");
    expect(out).toContain("https://example.dev/blog/one");
    expect(out).toContain(
      "platform blog · source manual · published 2026-09-01",
    );
    expect(out).toContain("tags: js");
    expect(out).toContain("views 1,200");
    expect(out).toContain("1 snapshot · 0 mentions");
  });

  it("shows the metrics series oldest-first with --metrics", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {
      publishedAt: "2026-08-20",
    });
    await executeContentFetch(
      id,
      { manual: true, views: "100" },
      conn,
      new Date("2026-09-01T12:00:00Z"),
    );
    await executeContentFetch(id, { manual: true, views: "130" }, conn, now);
    const out = await executeContentShow(id, { metrics: true }, conn, now);
    // Order matters inside the series table; the detail header above it also
    // carries dates, so compare within the table segment only.
    const table = out.slice(out.indexOf("fetched         source"));
    expect(table.indexOf("2026-09-01")).toBeLessThan(
      table.indexOf("2026-09-07"),
    );
    expect(out).toContain("2 of 2 snapshot(s), oldest first");
    expect(table).toContain("130");
  });

  it("resolves by URL including tracking params", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    const out = await executeContentShow(
      `https://example.dev/blog/one?utm_source=cli&utm_medium=test`,
      { json: true },
      conn,
      now,
    );
    expect((JSON.parse(out) as { id: string }).id).toBe(id);
  });

  it("errors not_found for an unknown ref", async () => {
    await expect(
      executeContentShow("https://nope.dev/x", {}, conn, now),
    ).rejects.toThrow(/No content found/);
  });
});

describe("content import", () => {
  it("imports a CSV file and reports created vs existing", async () => {
    const csv = filePath("content.csv", CONTENT_CSV);
    const first = await executeContentImport(
      undefined,
      { file: csv },
      conn,
      now,
    );
    expect(first).toContain("✓ Imported 2 row(s) (2 new, 0 already tracked)");
    const second = await executeContentImport(csv, {}, conn, now);
    expect(second).toContain("✓ Imported 2 row(s) (0 new, 2 already tracked)");
  });

  it("supports --dry-run and writes nothing", async () => {
    const csv = filePath("dry.csv", CONTENT_CSV);
    const out = await executeContentImport(csv, { dryRun: true }, conn, now);
    expect(out).toContain(
      "Preview — nothing written. 2 row(s) parsed; 2 new, 0 already tracked.",
    );
    expect(out).not.toContain("✓");
    const list = await executeContentList({ json: true }, conn, now);
    expect((JSON.parse(list) as { total: number }).total).toBe(0);
  });

  it("imports an RSS/Atom feed file", async () => {
    const feed = filePath("feed.xml", FEED_XML);
    const out = await executeContentImport(feed, {}, conn, now);
    expect(out).toContain("feed: Ada's blog");
    expect(out).toContain("✓ Imported 1 row(s) (1 new, 0 already tracked)");
    const list = await executeContentList({}, conn, now);
    expect(list).toContain("Feed post");
    // Unknown hosts in a feed fall back to the `rss` platform.
    expect(list).toContain("· rss  [");
    expect(list).not.toContain("article");
  });

  it("surfaces per-row CSV errors without failing the good rows", async () => {
    const csv = filePath(
      "partial.csv",
      [
        "url,title,platform,published_at",
        "https://example.dev/blog/ok,Good row,blog,2026-09-01",
        "not a url,Bad row,blog,2026-09-01",
      ].join("\n"),
    );
    const out = await executeContentImport(csv, {}, conn, now);
    // The bad row is a reported error, never a failed import.
    expect(out).toContain("✓ Imported 1 row(s) (1 new, 0 already tracked)");
    expect(out).toMatch(/row 3: .*URL/);
    const list = await executeContentList({ json: true }, conn, now);
    expect((JSON.parse(list) as { total: number }).total).toBe(1);
  });

  it("rejects when neither a positional nor --file is given", async () => {
    await expect(
      executeContentImport(undefined, {}, conn, now),
    ).rejects.toThrow(/file is required/);
  });
});

describe("content fetch", () => {
  it("records a manual snapshot from the numeric flags", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    const out = await executeContentFetch(
      id,
      { views: "1200", likes: "35", comments: "4" },
      conn,
      now,
    );
    expect(out).toContain('✓ Recorded a manual snapshot for "Blog one"');
    expect(out).toContain("views 1,200 · likes 35 · comments 4");
    const show = await executeContentShow(id, { json: true }, conn, now);
    const detail = JSON.parse(show) as {
      latestMetrics: { views: number; source: string } | null;
    };
    expect(detail.latestMetrics).toMatchObject({
      views: 1200,
      source: "manual",
    });
    // The list attaches the latest snapshot to the row.
    const listOut = await executeContentList({}, conn, now);
    expect(listOut).toContain("· 1,200 views");
  });

  it("requires at least one number for a manual snapshot", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    await expect(
      executeContentFetch(id, { manual: true }, conn, now),
    ).rejects.toThrow(/at least one number/);
  });

  it("explains that API providers are not configured, naming the key", async () => {
    const id = await seedItem("https://dev.to/ada/post", "Dev post", {
      platform: "devto",
    });
    await expect(executeContentFetch(id, {}, conn, now)).rejects.toThrow(
      /DEVTO_API_KEY/,
    );
    await expect(executeContentFetch(id, {}, conn, now)).rejects.toThrow(
      /--manual/,
    );
    const githubId = await seedItem("https://github.com/ada/repo", "Repo", {
      platform: "github",
    });
    await expect(executeContentFetch(githubId, {}, conn, now)).rejects.toThrow(
      /GITHUB_TOKEN/,
    );
  });

  it("says RSS feeds carry no engagement numbers", async () => {
    const id = await seedItem("https://example.dev/feed.xml", "Feed", {
      platform: "rss",
    });
    await expect(executeContentFetch(id, {}, conn, now)).rejects.toThrow(
      /no engagement numbers/,
    );
  });

  it("rejects an unknown --provider and a --manual + --provider conflict", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    await expect(
      executeContentFetch(id, { provider: "myspace" }, conn, now),
    ).rejects.toThrow(/Unknown provider/);
    await expect(
      executeContentFetch(id, { manual: true, provider: "rss" }, conn, now),
    ).rejects.toThrow(/cannot be combined/);
  });

  it("rejects a non-integer count", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    await expect(
      executeContentFetch(id, { manual: true, views: "1.5" }, conn, now),
    ).rejects.toThrow("--views must be a non-negative integer");
  });
});

describe("content rm", () => {
  it("removes the item and its children", async () => {
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    await executeContentFetch(id, { views: "10" }, conn, now);
    const out = await executeContentRm(id, {}, conn);
    expect(out).toContain('✗ Removed "Blog one"');
    const list = await executeContentList({}, conn, now);
    expect(list).toContain("No content tracked yet");
  });
});

describe("content analyze", () => {
  it("has an empty state", async () => {
    const out = await executeContentAnalyze({}, conn, now);
    expect(out).toContain("No content tracked yet");
    expect(out).toContain("netpro content add");
  });

  it("renders totals, top performers and the platform breakdown", async () => {
    const big = await seedItem("https://example.dev/blog/big", "Big post", {
      platform: "blog",
      publishedAt: "2026-09-01",
    });
    const small = await seedItem("https://dev.to/ada/small", "Small post", {
      platform: "devto",
      publishedAt: "2026-09-02",
    });
    await executeContentFetch(
      big,
      { manual: true, views: "500", likes: "10" },
      conn,
      now,
    );
    await executeContentFetch(
      small,
      { manual: true, views: "50", likes: "2" },
      conn,
      now,
    );
    const out = await executeContentAnalyze({}, conn, now);
    expect(out).toContain("Content library:");
    expect(out).toContain(
      "2 items · 2 measured · 2 snapshots · 550 latest-known views",
    );
    // Top performers lead with the bigger post.
    expect(out.indexOf("Big post")).toBeLessThan(out.indexOf("Small post"));
    expect(out).toContain("Top performers");
    expect(out).toContain("By platform");
    expect(out).toMatch(/devto\s+1 item · 50 latest-known views/);
    expect(out).toMatch(/blog\s+1 item · 500 latest-known views/);
  });

  it("windows by --days and states undated exclusions", async () => {
    const old = await seedItem("https://example.dev/blog/old", "Old post", {
      platform: "blog",
      publishedAt: "2026-01-01",
    });
    await executeContentFetch(old, { views: "900" }, conn, now);
    const undated = await seedItem(
      "https://example.dev/blog/undated",
      "Undated post",
      {},
    );
    await executeContentFetch(undated, { views: "1" }, conn, now);
    const out = await executeContentAnalyze({ days: "30" }, conn, now);
    expect(out).toContain("Content library (last 30 days):");
    expect(out).toContain("0 items · 0 measured");
    expect(out).toContain("1 undated item sits outside the window");
  });

  it("prints JSON", async () => {
    await seedItem("https://example.dev/blog/one", "Blog one", {});
    const raw = await executeContentAnalyze({ json: true }, conn, now);
    const parsed = JSON.parse(raw) as { items: number; days: null };
    expect(parsed.items).toBe(1);
    expect(parsed.days).toBeNull();
  });
});

describe("content renderers", () => {
  it("renderItemDetail prints a no-metrics guidance line", async () => {
    const { getContentItem } = await import("@netpro/core/src/content");
    const id = await seedItem("https://example.dev/blog/one", "Blog one", {});
    const detail = (await getContentItem(conn, id))!;
    const out = renderItemDetail(detail, now);
    expect(out).toContain("No metrics yet");
  });

  it("renderOverview prints platform rows", async () => {
    const { getContentOverview } = await import("@netpro/core/src/content");
    await seedItem("https://example.dev/blog/one", "Blog one", {
      platform: "blog",
    });
    const overview = await getContentOverview(conn, {});
    const out = renderOverview(overview);
    expect(out).toMatch(/blog\s+1 item · 0 latest-known views/);
    expect(out).toContain("No metrics yet");
  });

  it("renderImportSummary reports dry-runs and errors", () => {
    const dry = renderImportSummary({
      items: 2,
      created: 2,
      existing: 0,
      errors: [{ row: 2, reason: "boom" }],
      warnings: [],
      feed: null,
      dryRun: true,
    });
    expect(dry).toContain("Preview — nothing written");
    expect(dry).toContain("row 2: boom");
  });
});
