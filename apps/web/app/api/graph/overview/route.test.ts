import { describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  const f = createTestSqliteConn();
  const NOW = new Date("2026-09-07T12:00:00.000Z").toISOString();
  const rows = [
    { id: "a", fullName: "Ada", company: "Acme", relationshipScore: 0.9 },
    { id: "b", fullName: "Bob", company: "Acme", relationshipScore: 0.6 },
    { id: "z", fullName: "Zoe", company: "Beta", relationshipScore: 0.2 },
    { id: "l", fullName: "Lonely", company: "Beta", relationshipScore: 0.1 },
  ];
  for (const r of rows) {
    await f.conn.db.insert(f.conn.schema.contacts).values({
      ...r, source: "test", createdAt: NOW, updatedAt: NOW,
    });
  }
  await f.conn.db.insert(f.conn.schema.edges).values([
    { id: "e1", sourceId: "a", targetId: "b", relation: "colleague", strength: 0.7, confidence: 1, status: "confirmed", bidirectional: true, source: "manual", discoveredAt: NOW, updatedAt: NOW },
    { id: "e2", sourceId: "b", targetId: "z", relation: "met_at_event", strength: 0.5, confidence: 1, status: "confirmed", bidirectional: true, source: "manual", discoveredAt: NOW, updatedAt: NOW },
    { id: "e3", sourceId: "a", targetId: "l", relation: "mutual_network", strength: 0.3, confidence: 0.5, status: "pending", bidirectional: true, source: "linkedin_csv", discoveredAt: NOW, updatedAt: NOW },
  ]);
  return f;
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET } from "./route";

const get = (url: string) => GET(new Request(`http://localhost${url}`));

describe("GET /api/graph/overview", () => {
  it("returns the merged graph view (confirmed edges only by default)", async () => {
    const res = await get("/api/graph/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: number; edges: number; totalContacts: number; coverage: number;
      pendingCandidates: number; degraded: unknown;
      communities: { count: number; top: Array<{ label: string; size: number }> };
      centrality: { top: Array<{ contactId: string; degree: number }> };
      components: { count: number };
      avgPathLength: { value: number | null };
      warmIntros: unknown[];
    };
    expect(body.totalContacts).toBe(4);
    expect(body.nodes).toBe(3); // confirmed edges touch a, b, z — not lonely l
    expect(body.edges).toBe(2);
    expect(body.pendingCandidates).toBe(1);
    expect(body.degraded).toBeNull();
    expect(body.communities.top[0]).toMatchObject({ label: "acme", size: 3 });
    expect(body.centrality.top[0]).toMatchObject({ contactId: "b", degree: 2 });
    expect(body.components.count).toBe(1);
    expect(body.avgPathLength.value).toBe(1.33); // (1 + 1 + 2)/3 exact on P3
    expect(body.warmIntros.length).toBeGreaterThan(0); // Ada↔Zoe pairs via Bob exist only from l? none — see below
  });

  it("status=pending narrows to the candidates the owner has not confirmed", async () => {
    const res = await get("/api/graph/overview?status=pending");
    const body = (await res.json()) as { edges: number; nodes: number };
    expect(body.edges).toBe(1);
    expect(body.nodes).toBe(2);
  });

  it("validates relation and status against the whitelists (400)", async () => {
    expect((await get("/api/graph/overview?relation=telepathy")).status).toBe(400);
    expect((await get("/api/graph/overview?status=maybe")).status).toBe(400);
    expect((await get("/api/graph/overview?minConfidence=9")).status).toBe(400);
  });

  it("honors limit and depth within the web caps", async () => {
    const res = await get("/api/graph/overview?limit=1&depth=5");
    const body = (await res.json()) as {
      communities: { top: unknown[] };
      centrality: { top: unknown[] };
      warmIntros: unknown[];
    };
    expect(body.communities.top.length).toBeLessThanOrEqual(1);
    expect(body.centrality.top.length).toBeLessThanOrEqual(1);
    expect(body.warmIntros.length).toBeLessThanOrEqual(1);
  });
});
