import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
// The panels are client components (useRouter); stub them so the server render
// stays static — their APIs are covered by the route tests.
vi.mock("../panels", () => ({
  RecordMetricsForm: () => <div data-testid="record-metrics" />,
  AddMentionForm: () => <div data-testid="add-mention" />,
  RemoveMentionButton: () => <button>Remove</button>,
  RemoveContentButton: () => <button>Delete content</button>,
}));

import ContentDetailPage from "./page";

// Seeds are relative to the wall clock, because the page renders "today" /
// "2d ago" against the real clock (the server page cannot take an injected
// now).
const now = new Date();
const NOW_ISO = now.toISOString();
const TWO_DAYS_AGO = new Date(
  now.getTime() - 2 * 24 * 60 * 60 * 1000,
).toISOString();

async function render(id: string): Promise<string> {
  const element = await ContentDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

let itemId = "";

beforeEach(async () => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  for (const r of [
    {
      id: "a",
      fullName: "Ada Lovelace",
      email: "ada@engines.dev",
      company: "Engines",
      industry: "fintech",
      relationshipScore: 0.9,
    },
    {
      id: "gone",
      fullName: "Ghost",
      email: "ghost@example.com",
      deletedAt: NOW_ISO,
      relationshipScore: 0.2,
    },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        ...r,
        source: "test",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        company: r.company ?? null,
        industry: r.industry ?? null,
      })
      .run();
  }
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url: "https://example.dev/blog/one",
      title: "Blog one",
      platform: "blog",
      publishedAt: NOW_ISO,
      tags: ["js", "web"],
      summary: "A post about one thing.",
    },
    { now },
  );
  itemId = item.id;
});
afterAll(() => fixture.sqlite.close());

describe("/content/[id] page", () => {
  it("renders the piece, its latest snapshot and its history", async () => {
    const { recordMetrics } = await import("@netpro/core/src/content");
    await recordMetrics(
      fixture.conn,
      { contentId: itemId, views: 100, likes: 3 },
      { now: new Date(TWO_DAYS_AGO) },
    );
    await recordMetrics(
      fixture.conn,
      { contentId: itemId, views: 1200, likes: 40 },
      { now },
    );
    const html = await render(itemId);
    expect(html).toContain("<h1>Blog one</h1>");
    expect(html).toContain("https://example.dev/blog/one");
    expect(html).toContain("Blog · source manual");
    expect(html).toContain("(today)");
    expect(html).toContain("#js");
    expect(html).toContain("#web");
    expect(html).toContain("A post about one thing.");
    expect(html).toContain("Latest snapshot");
    expect(html).toContain("1,200");
    expect(html).toContain("40");
    // History is oldest-first.
    const history = html.slice(html.indexOf("History"));
    expect(history.indexOf("100")).toBeLessThan(history.indexOf("1,200"));
    expect(html).toContain("record-metrics");
  });

  it("lists the contacts a piece involves with their context and unlink action", async () => {
    const { addContentMention } = await import("@netpro/core/src/content");
    await addContentMention(fixture.conn, {
      contentId: itemId,
      contactId: "a",
      context: "co-authored",
    });
    const html = await render(itemId);
    expect(html).toContain("Contacts (1)");
    expect(html).toContain('href="/contacts/a"');
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("co-authored");
    expect(html).toContain("Remove");
    expect(html).toContain("add-mention");
    expect(html).not.toContain("Ghost");
  });

  it("has an empty state for a piece with no snapshots or mentions", async () => {
    const html = await render(itemId);
    expect(html).toContain("No snapshots yet — add the first numbers below.");
    expect(html).toContain("Nothing recorded yet.");
    expect(html).toContain("Nobody linked yet");
    expect(html).toContain("Delete content");
  });

  it("resolves the piece by its URL with tracking junk, and 404s unknown selectors", async () => {
    const html = await render("https://example.dev/blog/one?utm_source=web");
    expect(html).toContain("<h1>Blog one</h1>");
    await expect(render("nope")).rejects.toThrow();
    await expect(render("https://example.dev/not-tracked")).rejects.toThrow();
  });
});
