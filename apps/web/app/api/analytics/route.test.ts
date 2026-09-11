import { describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  const f = createTestSqliteConn();
  const NOW = new Date("2026-09-06T12:00:00.000Z");
  const iso = (daysAgo: number) =>
    new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

  const rows = [
    {
      id: "c1",
      fullName: "Jane Doe",
      email: "jane@stripe.com",
      company: "Stripe",
      role: "Senior Engineer",
      industry: "Fintech",
      relationshipScore: 0.8,
      lastInteraction: iso(5),
      createdAt: iso(400),
    },
    {
      id: "c2",
      fullName: "John Smith",
      email: "john@acme.com",
      company: "Stripe",
      role: "Engineer",
      industry: "Fintech",
      relationshipScore: 0.4,
      lastInteraction: null,
      createdAt: iso(200),
    },
    {
      id: "c3",
      fullName: "Alice Wong",
      email: null,
      company: "Acme",
      role: "Designer",
      industry: "Software",
      relationshipScore: 0.2,
      lastInteraction: iso(120),
      createdAt: iso(120),
    },
  ];
  for (const r of rows) {
    await f.conn.db.insert(f.conn.schema.contacts).values({
      ...r,
      source: "test",
      updatedAt: NOW.toISOString(),
    });
  }
  // One confirmed edge (Jane–John) and one pending candidate (John–Alice):
  // the graph section must count the first and only expose the second as a
  // pending candidate.
  await f.conn.db.insert(f.conn.schema.edges).values([
    {
      id: "e1",
      sourceId: "c1",
      targetId: "c2",
      relation: "colleague",
      strength: 0.6,
      bidirectional: true,
      source: "manual",
      confidence: 1,
      status: "confirmed",
      discoveredAt: iso(50),
      updatedAt: iso(50),
    },
    {
      id: "e2",
      sourceId: "c2",
      targetId: "c3",
      relation: "mutual_network",
      strength: 0.5,
      bidirectional: true,
      source: "linkedin_csv",
      confidence: 0.5,
      status: "pending",
      discoveredAt: iso(10),
      updatedAt: iso(10),
    },
  ]);
  return f;
});
vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    role: "owner",
    userId: "system",
  }),
}));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET } from "./route";

function get(url: string): Promise<Response> {
  return GET(new Request(`http://localhost${url}`));
}

describe("GET /api/analytics", () => {
  it("returns the full overview", async () => {
    const res = await get("/api/analytics");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      metrics: { totalContacts: number; dormantConnections: number };
      score: { score: number };
      growth: { series: unknown[]; last30: number };
      topCompanies: Array<{ value: string; count: number }>;
      clusters: Array<{ key: string; size: number }>;
      dormant: Array<{ id: string }>;
      graph: {
        nodes: number;
        edges: number;
        pendingCandidates: number;
        components: { count: number };
        avgPathLength: { value: number | null };
        communities: { count: number };
        warmIntros: unknown[];
      };
      generatedAt: string;
    };

    expect(body.metrics.totalContacts).toBe(3);
    expect(body.metrics.dormantConnections).toBe(2);
    expect(body.score.score).toBeGreaterThan(0);
    expect(body.growth.series).toHaveLength(12);
    expect(body.topCompanies[0]).toMatchObject({ value: "stripe", count: 2 });
    expect(body.clusters[0]).toMatchObject({ key: "stripe", size: 2 });
    expect(body.dormant).toHaveLength(2);
    expect(typeof body.generatedAt).toBe("string");

    // v2.0 Phase 2 — the graph section rides along in the same payload.
    expect(body.graph.nodes).toBe(2); // confirmed edge only
    expect(body.graph.edges).toBe(1);
    expect(body.graph.pendingCandidates).toBe(1);
    expect(body.graph.components).toMatchObject({ count: 1 });
    expect(body.graph.avgPathLength.value).toBe(1);
    expect(body.graph.communities.count).toBeGreaterThanOrEqual(1);
    expect(body.graph.warmIntros).toEqual([]); // 2-node graph has no 2-hop pairs
  });

  it("omits the graph section with ?graph=0", async () => {
    const res = await get("/api/analytics?graph=0");
    const body = (await res.json()) as { graph?: unknown; metrics: unknown };
    expect(body.graph).toBeUndefined();
    expect(body.metrics).toBeDefined();
  });

  it("includes the viewer-analytics section by default, omitted with ?views=0 (v2.5 phase 3)", async () => {
    const res = await get("/api/analytics");
    const body = (await res.json()) as {
      views?: {
        stats: {
          window: { days: number };
          totals: { views: number };
          series: unknown[];
        };
        recent: { limit: number };
      };
    };
    expect(body.views?.stats.window.days).toBe(30);
    expect(body.views?.stats.totals.views).toBe(0);
    expect(body.views?.stats.series).toHaveLength(30);
    expect(body.views?.recent.limit).toBe(5);

    const slim = await get("/api/analytics?views=0");
    const slimBody = (await slim.json()) as { views?: unknown; graph: unknown };
    expect(slimBody.views).toBeUndefined();
    expect(slimBody.graph).toBeDefined();
  });

  it("includes the content overview by default, omitted with ?content=0 (v2.5 phase 6)", async () => {
    const { upsertContentItem } = await import("@netpro/core/src/content");
    await upsertContentItem(
      fixture.conn,
      {
        url: "https://example.dev/blog/api",
        title: "API post",
        platform: "blog",
      },
      { now: new Date("2026-09-06T12:00:00.000Z") },
    );
    try {
      const res = await get("/api/analytics");
      const body = (await res.json()) as {
        content?: { days: number | null; items: number; top: unknown[] };
        views: unknown;
      };
      expect(body.content).toMatchObject({ days: null, items: 1 });
      expect(body.views).toBeDefined(); // other sections untouched

      const slim = await get("/api/analytics?content=0");
      const slimBody = (await slim.json()) as {
        content?: unknown;
        views: unknown;
      };
      expect(slimBody.content).toBeUndefined();
      expect(slimBody.views).toBeDefined();
    } finally {
      fixture.sqlite.exec(
        "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items;",
      );
    }
  });

  it("accepts the dormancy window via ?days=", async () => {
    const res = await get("/api/analytics?days=150");
    const body = (await res.json()) as {
      metrics: { dormantConnections: number };
      dormant: unknown[];
    };
    // At 150d, Alice (120d) falls inside the window; only John (200d) is dormant.
    expect(body.metrics.dormantConnections).toBe(1);
    expect(body.dormant).toHaveLength(1);
  });

  it("caps list sizes via ?limit=", async () => {
    const res = await get("/api/analytics?limit=1");
    const body = (await res.json()) as {
      dormant: unknown[];
      clusters: unknown[];
    };
    expect(body.dormant).toHaveLength(1);
    expect(body.clusters).toHaveLength(1);
  });

  it("ignores non-numeric params rather than crashing", async () => {
    const res = await get("/api/analytics?days=banana&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: { dormantConnections: number };
      dormant: unknown[];
    };
    expect(body.metrics.dormantConnections).toBe(2);
    expect(body.dormant).toHaveLength(2);
  });
});
