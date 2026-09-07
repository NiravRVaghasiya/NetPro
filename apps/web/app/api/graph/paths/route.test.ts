import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  const f = createTestSqliteConn();
  const NOW = new Date("2026-09-07T12:00:00.000Z");
  const iso = (daysAgo: number) =>
    new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

  const rows = [
    { id: "a", fullName: "Ada Lovelace", email: "ada@engines.dev", company: "Engines", role: "Founder", relationshipScore: 0.9, lastInteraction: iso(5) },
    { id: "b", fullName: "Bob Bridge", company: "Engines", role: "PM", relationshipScore: 0.6, lastInteraction: iso(60) },
    { id: "c", fullName: "Cara", company: "Vercel", role: "Designer", relationshipScore: 0.3, lastInteraction: null },
    { id: "z", fullName: "Zoe Target", company: "Acme", role: "CTO", relationshipScore: 0.1, lastInteraction: null },
  ];
  for (const r of rows) {
    await f.conn.db.insert(f.conn.schema.contacts).values({
      ...r,
      source: "test",
      createdAt: iso(300),
      updatedAt: NOW.toISOString(),
    });
  }
  await f.conn.db.insert(f.conn.schema.edges).values([
    { id: "e1", sourceId: "a", targetId: "b", relation: "colleague", strength: 0.7, confidence: 1, status: "confirmed", bidirectional: true, source: "manual", discoveredAt: iso(9), updatedAt: iso(9) },
    { id: "e2", sourceId: "b", targetId: "z", relation: "met_at_event", strength: 0.5, confidence: 1, status: "confirmed", bidirectional: true, source: "manual", discoveredAt: iso(9), updatedAt: iso(9) },
    { id: "e3", sourceId: "a", targetId: "c", relation: "mutual_network", strength: 0.4, confidence: 0.5, status: "pending", bidirectional: true, source: "linkedin_csv", discoveredAt: iso(2), updatedAt: iso(2) },
    { id: "e4", sourceId: "c", targetId: "z", relation: "mutual_network", strength: 0.4, confidence: 0.5, status: "pending", bidirectional: true, source: "linkedin_csv", discoveredAt: iso(2), updatedAt: iso(2) },
  ]);
  return f;
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET } from "./route";

interface PlanBody {
  origin: { contactId: string; selectedBy: string };
  target: { contactId: string };
  found: boolean;
  maxDepth: number;
  paths: Array<{
    rank: number;
    hops: number;
    path: Array<{ contactId: string; relationshipScore: number | null; lastInteraction: string | null }>;
    score: { score: number };
    ask: { contactId: string; suggestion: string };
  }>;
}

const get = (url: string) => GET(new Request(`http://localhost${url}`));

describe("GET /api/graph/paths", () => {
  it("plans the confirmed chain with ranked paths and the ask", async () => {
    const res = await get("/api/graph/paths?target=Zoe%20Target&from=ada@engines.dev");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as PlanBody;
    expect(body.origin).toMatchObject({ contactId: "a", selectedBy: "explicit" });
    expect(body.target.contactId).toBe("z");
    expect(body.found).toBe(true);
    expect(body.paths[0]).toMatchObject({ hops: 2, rank: 1 });
    expect(body.paths[0]!.path.map((n) => n.contactId)).toEqual(["a", "b", "z"]);
    // The pending-only route a→c→z is invisible by default…
    expect(body.paths).toHaveLength(1);
    // …and every node carries score + recency for the UI.
    expect(body.paths[0]!.path[1]).toMatchObject({
      contactId: "b",
      relationshipScore: 0.6,
      lastInteraction: expect.any(String),
    });
    expect(body.paths[0]!.ask.contactId).toBe("a");
    expect(body.paths[0]!.ask.suggestion).toContain("Ask Ada Lovelace");
  });

  it("status=all opens the pending shortcuts and k caps alternatives", async () => {
    const res = await get("/api/graph/paths?target=z&from=a&status=all&k=2");
    const body = (await res.json()) as PlanBody;
    expect(res.status).toBe(200);
    expect(body.paths).toHaveLength(2);
    // a→b→z: weakest tie min(.9,.6)=.6, hops avg (.7*1, .5*1)=.6 → 0.6*.6+0.4*.6=0.6
    // a→c→z: weakest tie min(.9,.3)=.3, hops avg (.4*.5,.4*.5)=.2 → 0.6*.3+0.4*.2=0.26
    expect(body.paths[0]!.path.map((n) => n.contactId)).toEqual(["a", "b", "z"]);
    expect(body.paths[0]!.score.score).toBeCloseTo(0.6, 3);
    expect(body.paths[1]!.score.score).toBeCloseTo(0.26, 3);
  });

  it("caps depth at 6 (web budget) — 99 falls back to 6, banana to the default 4", async () => {
    const capped = (await (await get("/api/graph/paths?target=z&from=a&depth=99")).json()) as { maxDepth: number };
    expect(capped.maxDepth).toBe(6);
    const def = (await (await get("/api/graph/paths?target=z&from=a&depth=banana")).json()) as { maxDepth: number };
    expect(def.maxDepth).toBe(4);
    const zero = (await (await get("/api/graph/paths?target=z&from=a&depth=0")).json()) as { maxDepth: number };
    expect(zero.maxDepth).toBe(1);
  });

  it("400s without a target", async () => {
    const res = await get("/api/graph/paths");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("required");
  });

  it("404s for an unknown target and 400s for an ambiguous one", async () => {
    const miss = await get("/api/graph/paths?target=nobody@nowhere.xx");
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { code: string }).code).toBe("not_found");

    await fixture.conn.db.insert(fixture.conn.schema.contacts).values({
      id: "twin2", fullName: "Zoe Target", source: "test",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const amb = await get("/api/graph/paths?target=Zoe%20Target");
    expect(amb.status).toBe(400);
    expect(((await amb.json()) as { code: string }).code).toBe("invalid_input");
    await fixture.conn.db
      .delete(fixture.conn.schema.contacts)
      .where(eq(fixture.conn.schema.contacts.id, "twin2"));
  });

});
