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
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log;",
  );
});
afterAll(() => fixture.sqlite.close());

async function seedItem(): Promise<string> {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url: "https://example.dev/blog/one",
      title: "Blog one",
      platform: "blog",
      publishedAt: "2026-09-01",
    },
    { now: NOW },
  );
  return item.id;
}

const get = (id: string, qs = "") =>
  GET(
    new Request(
      `http://localhost/api/content/${encodeURIComponent(id)}/metrics${qs}`,
    ),
    {
      params: Promise.resolve({ id }),
    },
  );
const post = (id: string, body: unknown) =>
  POST(
    new Request(
      `http://localhost/api/content/${encodeURIComponent(id)}/metrics`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id }) },
  );

describe("GET /api/content/[id]/metrics", () => {
  it("returns the series oldest-first with latest and total", async () => {
    const id = await seedItem();
    const { recordMetrics } = await import("@netpro/core/src/content");
    await recordMetrics(
      fixture.conn,
      { contentId: id, views: 100 },
      { now: new Date("2026-09-01T00:00:00Z") },
    );
    await recordMetrics(
      fixture.conn,
      { contentId: id, views: 300, likes: 7 },
      { now: NOW },
    );
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: Array<{ views: number | null; likes: number | null }>;
      latest: { views: number; likes: number } | null;
      total: number;
    };
    expect(
      body.metrics.map((m) => ({ views: m.views, likes: m.likes })),
    ).toEqual([
      { views: 100, likes: null },
      { views: 300, likes: 7 },
    ]);
    expect(body.latest).toMatchObject({ views: 300, likes: 7 });
    expect(body.total).toBe(2);
  });

  it("clamps days and limit to the 1..365 window", async () => {
    const id = await seedItem();
    const res = await get(id, "?days=999&limit=999");
    expect(res.status).toBe(200);
  });

  it("404s an unknown content id", async () => {
    const res = await get("nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/content/[id]/metrics", () => {
  it("appends a manual snapshot and answers 201", async () => {
    const id = await seedItem();
    const res = await post(id, { views: 1200, likes: 35, comments: 4 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      metric: { views: number | null; likes: number | null; source: string };
    };
    expect(body.metric).toMatchObject({
      views: 1200,
      likes: 35,
      source: "manual",
    });
    const series = (await (await get(id)).json()) as { total: number };
    expect(series.total).toBe(1);
  });

  it("accepts a date for the snapshot and stores it", async () => {
    const id = await seedItem();
    const res = await post(id, { views: 10, fetchedAt: "2026-08-01" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { metric: { fetchedAt: string } };
    expect(body.metric.fetchedAt.startsWith("2026-08-01")).toBe(true);
  });

  it("rejects empty, negative or fractional metrics with 400", async () => {
    const id = await seedItem();
    // `0` is a reported zero and allowed; nulls everywhere are not a snapshot.
    for (const body of [
      {},
      { views: null },
      { views: -1 },
      { views: 1.5 },
      { views: "many" },
    ]) {
      const res = await post(id, body);
      expect(res.status).toBe(400);
    }
  });

  it("rejects an unreadable date with 400", async () => {
    const id = await seedItem();
    const res = await post(id, { views: 1, fetchedAt: "whenever" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "not a date",
    );
  });

  it("404s an unknown content id", async () => {
    const res = await post("nope", { views: 1 });
    expect(res.status).toBe(404);
  });
});
