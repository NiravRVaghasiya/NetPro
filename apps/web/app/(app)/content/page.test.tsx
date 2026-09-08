import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
// The panels are client components (useRouter); stub them so the server render
// stays static — their APIs are covered by the route tests.
vi.mock("./panels", () => ({
  AddContentForm: () => <div data-testid="add-content-form" />,
  ImportContentPanel: () => <div data-testid="import-panel" />,
}));

import ContentPage from "./page";

const now = new Date();
const NOW_ISO = now.toISOString();
const THREE_DAYS_AGO = new Date(
  now.getTime() - 3 * 24 * 60 * 60 * 1000,
).toISOString();
const TEN_DAYS_AGO = new Date(
  now.getTime() - 10 * 24 * 60 * 60 * 1000,
).toISOString();

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await ContentPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

let ids: Record<string, string> = {};

async function seedItem(
  key: string,
  url: string,
  title: string,
  publishedAt: string | null,
  platform: string,
  tags?: string[],
): Promise<string> {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url,
      title,
      platform,
      publishedAt: publishedAt ?? undefined,
      tags: tags ?? [],
    },
    { now },
  );
  ids[key] = item.id;
  return item.id;
}

/** Snapshots are appended in list order, each a minute after the last. */
async function snapshots(
  contentId: string,
  rows: Array<{ views?: number; likes?: number }>,
): Promise<void> {
  const { recordMetrics } = await import("@netpro/core/src/content");
  for (const [i, r] of rows.entries()) {
    await recordMetrics(
      fixture.conn,
      { contentId, views: r.views ?? null, likes: r.likes ?? null },
      { now: new Date(now.getTime() - (rows.length - 1 - i) * 60_000) },
    );
  }
}

/** The list alone — the overview below the table ranks across filters. */
function tableOf(html: string): string {
  return (
    html.match(
      /<table[^>]*data-testid="content-table"[\s\S]*?<\/table>/,
    )?.[0] ?? ""
  );
}

beforeEach(async () => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  ids = {};
  await seedItem(
    "fresh",
    "https://example.dev/blog/fresh",
    "The fresh post",
    NOW_ISO,
    "blog",
    ["js"],
  );
  await seedItem(
    "old",
    "https://dev.to/ada/old",
    "The devto old post",
    TEN_DAYS_AGO,
    "devto",
    ["rust"],
  );
  await snapshots(ids.fresh!, [
    { views: 100, likes: 3 },
    { views: 1200, likes: 40 },
  ]);
});
afterAll(() => fixture.sqlite.close());

describe("/content page", () => {
  it("renders the tracker, the latest numbers, the overview and the panels", async () => {
    const html = await render();
    expect(html).toContain("<h1>Content</h1>");
    expect(html).toContain("2 items · 1 measured · 2 snapshots.");
    expect(html).toContain("The fresh post");
    expect(html).toContain("The devto old post");
    expect(html).toContain("(today)");
    expect(html).toContain("(10d ago)");
    expect(html).toContain("1,200 views"); // latest snapshot on the row
    expect(html).toContain("no snapshots yet"); // second row has no metrics
    expect(html).toContain("add-content-form");
    expect(html).toContain("import-panel");
  });

  it("links each row to its detail page and breaks the overview down by platform", async () => {
    const html = await render();
    expect(html).toContain(`href="/content/${ids.fresh}"`);
    expect(html).toContain(`href="/content/${ids.old}"`);
    expect(html).toContain("<h2>At a glance</h2>");
    expect(html).toContain(
      "2 items in view · 1 measured · 1,200 latest-known views",
    );
    // Top performers: only the measured item qualifies — the unmeasured row
    // appears in the table above the overview, not in the ranking.
    const afterOverview = html.slice(html.indexOf("Top performers"));
    expect(afterOverview).toContain("The fresh post");
    expect(afterOverview).not.toContain("The devto old post");
    expect(afterOverview).toContain("(Blog) — 1,200 views");
    expect(html).toContain(
      '<a href="/content?platform=blog">Blog</a> — 1 item · 1,200 views',
    );
    expect(html).toContain(
      '<a href="/content?platform=devto">dev.to</a> — 1 item · 0 views',
    );
  });

  it("filters by platform and offers a clear link", async () => {
    const html = await render({ platform: "devto" });
    const table = tableOf(html);
    expect(table).toContain("The devto old post");
    expect(table).not.toContain("The fresh post");
    expect(html).toContain('href="/content"');
  });

  it("filters by tag and by text query", async () => {
    const byTag = tableOf(await render({ tag: "js" }));
    expect(byTag).toContain("The fresh post");
    expect(byTag).not.toContain("The devto old post");
    const byQuery = tableOf(await render({ query: "devto" }));
    expect(byQuery).toContain("The devto old post");
    expect(byQuery).not.toContain("The fresh post");
  });

  it("windows to the last 7 days and reports undated items outside it", async () => {
    await seedItem(
      "undated",
      "https://example.dev/undated",
      "An undated note",
      null,
      "blog",
    );
    const html = await render({ days: "7" });
    expect(html).toContain("Showing 1 of 1.");
    expect(html).toContain("The fresh post");
    expect(html).not.toContain("The devto old post");
    expect(html).not.toContain("An undated note");
    expect(html).toContain(
      "3 items · 1 measured · 2 snapshots · 1 undated outside the window.",
    );
    expect(html).toContain("<h2>At a glance (last 7 days)</h2>");
    expect(html).toContain(
      "1 item in view · 1 measured · 1,200 latest-known views",
    );
    expect(html).toContain("1 undated excluded from the window");
  });

  it("has an all-time empty state without the overview, and a windowed one with it", async () => {
    fixture.sqlite.exec(
      "DELETE FROM content_metrics; DELETE FROM content_items;",
    );
    const empty = await render();
    expect(empty).toContain(
      "No content here yet — track your first piece below",
    );
    expect(empty).not.toContain("At a glance");
    expect(empty).toContain("add-content-form");
    expect(empty).toContain("import-panel");

    await seedItem(
      "later",
      "https://example.dev/blog/later",
      "Out of the window",
      THREE_DAYS_AGO,
      "blog",
    );
    const windowed = await render({ days: "1" });
    expect(windowed).toContain("No content here (last 1 days) yet");
    expect(windowed).toContain("At a glance (last 1 days)");
  });

  it("clamps an out-of-range days selector instead of rendering nonsense", async () => {
    const html = await render({ days: "9999" });
    // num() clamps to 365 → both dated posts are in view.
    expect(html).toContain("The devto old post");
    expect(html).toContain("Showing 2 of 2.");
  });
});
