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

import { DELETE, GET } from "./route";

const NOW = new Date("2026-09-07T12:00:00.000Z");

beforeEach(() => {
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
      id: "b",
      fullName: "Bob Builder",
      email: "bob@builders.io",
      company: "Builders",
      industry: "fintech",
      relationshipScore: 0.6,
    },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        ...r,
        source: "test",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

async function seedItem(): Promise<string> {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url: "https://example.dev/blog/one?utm_source=web",
      title: "Blog one",
      platform: "blog",
      publishedAt: "2026-09-01",
    },
    { now: NOW },
  );
  return item.id;
}

const get = (id: string) =>
  GET(new Request(`http://localhost/api/content/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ id }),
  });
const del = (id: string) =>
  DELETE(
    new Request(`http://localhost/api/content/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
    {
      params: Promise.resolve({ id }),
    },
  );

describe("GET /api/content/[id]", () => {
  it("returns the piece with its latest snapshot and its mentions", async () => {
    const id = await seedItem();
    const { recordMetrics, addContentMention } =
      await import("@netpro/core/src/content");
    await recordMetrics(
      fixture.conn,
      { contentId: id, views: 1200, likes: 40 },
      { now: NOW },
    );
    await addContentMention(fixture.conn, {
      contentId: id,
      contactId: "a",
      context: "co-authored",
    });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      id: string;
      latestMetrics: { views: number } | null;
      metricsCount: number;
      mentionsCount: number;
      mentions: Array<{
        contactId: string;
        fullName: string;
        email: string | null;
        context: string | null;
      }>;
    };
    expect(body.id).toBe(id);
    expect(body.latestMetrics).toMatchObject({ views: 1200 });
    expect(body.metricsCount).toBe(1);
    expect(body.mentionsCount).toBe(1);
    expect(body.mentions).toEqual([
      {
        contentId: id,
        contactId: "a",
        fullName: "Ada Lovelace",
        email: "ada@engines.dev",
        context: "co-authored",
      },
    ]);
  });

  it("resolves a selector that is the exact URL, tracking junk tolerated", async () => {
    const id = await seedItem();
    const res = await get("https://example.dev/blog/one");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);
  });

  it("404s an unknown id or URL", async () => {
    for (const selector of ["nope", "https://example.dev/not-tracked"]) {
      const res = await get(selector);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain(
        "No content found",
      );
    }
  });
});

describe("DELETE /api/content/[id]", () => {
  it("removes the item, its snapshots and its mentions", async () => {
    const id = await seedItem();
    const { recordMetrics, addContentMention } =
      await import("@netpro/core/src/content");
    await recordMetrics(
      fixture.conn,
      { contentId: id, views: 5 },
      { now: NOW },
    );
    await addContentMention(fixture.conn, { contentId: id, contactId: "a" });
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: { id: string } }).removed.id).toBe(
      id,
    );
    expect((await get(id)).status).toBe(404);
    const orphans = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM content_metrics WHERE content_id = ?")
      .get(id) as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("404s on a second delete", async () => {
    const id = await seedItem();
    await del(id);
    expect((await del(id)).status).toBe(404);
  });
});
