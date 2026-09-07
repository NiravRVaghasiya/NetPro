import { describe, it, expect, vi } from "vitest";

// v2.0 Phase 4 moved this onto the migrated fixture: the keyword arm needs the
// real `search_index` + FTS5 objects that migration 0004 creates, and
// duplicating that DDL in a test would let the two drift.
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});

vi.mock("@/lib/db", () => {
  const { conn } = fixture;
  const { db, schema } = conn;
  const now = new Date().toISOString();
  const rows = [
    {
      id: "c1",
      fullName: "Jane Doe",
      email: "jane@stripe.com",
      company: "Stripe",
      role: "Senior Engineer",
      seniority: "senior",
      location: "Berlin",
      industry: "Fintech",
      relationshipScore: 0.8,
      notes: null,
    },
    {
      id: "c2",
      fullName: "John Smith",
      email: "john@vercel.com",
      company: "Vercel",
      role: "Product Manager",
      seniority: "mid",
      location: "San Francisco",
      industry: "Software",
      relationshipScore: 0.5,
      notes: null,
    },
    {
      id: "c3",
      fullName: "Alice Wong",
      email: null,
      company: "Vercel",
      role: "Designer",
      seniority: "junior",
      location: "Berlin",
      industry: "Software",
      relationshipScore: 0.2,
      notes: "Met at PyCon",
    },
  ];
  for (const r of rows) {
    db.insert(schema.contacts)
      .values({ ...r, source: "linkedin_csv", createdAt: now, updatedAt: now })
      .run();
  }
  return { conn };
});

const { GET } = await import("./route");
const { reindexSearchIndex } = await import("@netpro/core/src/search");

describe("GET /api/search", () => {
  it("returns all contacts with facets when no params given", async () => {
    const res = await GET(new Request("http://localhost/api/search"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.contacts).toHaveLength(3);
    expect(body.facets).toBeDefined();
    expect(body.facets.company[0].value).toBeDefined();
  });

  it("filters by free-text query", async () => {
    const res = await GET(new Request("http://localhost/api/search?q=vercel"));
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.contacts.map((c: { id: string }) => c.id).sort()).toEqual([
      "c2",
      "c3",
    ]);
  });

  it("applies seniority and hasEmail filters", async () => {
    const res = await GET(
      new Request("http://localhost/api/search?seniority=senior&hasEmail=true"),
    );
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.contacts[0].id).toBe("c1");
  });

  it("returns 400 for an invalid sort", async () => {
    const res = await GET(
      new Request("http://localhost/api/search?sort=bogus"),
    );
    expect(res.status).toBe(400);
  });

  it("respects limit and offset for pagination", async () => {
    const res = await GET(
      new Request("http://localhost/api/search?limit=2&offset=2&sort=name"),
    );
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].fullName).toBe("John Smith");
  });
});

// ── v2.0 Phase 4: hybrid search ──────────────────────────────────────────

describe("GET /api/search — engine modes", () => {
  const call = (query: string) =>
    GET(new Request(`http://localhost/api/search${query}`));

  it("reports the portable engine by default and runs no arms", async () => {
    const body = await (await call("?q=vercel")).json();
    expect(body.engine).toMatchObject({ mode: "portable", requested: "portable" });
    expect(body.engine.arms.keyword.used).toBe(false);
    expect(body.total).toBe(2);
  });

  it("rejects an unknown mode with 400 rather than downgrading silently", async () => {
    const res = await call("?q=x&mode=vector");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/portable, keyword, hybrid/);
  });

  it.each(["portable", "keyword", "hybrid"])("accepts mode=%s", async (mode) => {
    expect((await call(`?q=vercel&mode=${mode}`)).status).toBe(200);
  });

  it("degrades to portable — with a reason — before the index is built", async () => {
    const body = await (await call("?q=vercel&mode=keyword")).json();
    expect(body.engine.arms.keyword).toMatchObject({
      used: false,
      reason: "index_empty",
    });
    expect(body.contacts.map((c: { id: string }) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("serves the keyword engine once the index exists", async () => {
    await reindexSearchIndex(fixture.conn);
    const body = await (await call("?q=vercel&mode=keyword")).json();
    expect(body.engine.mode).toBe("keyword");
    expect(body.engine.arms.keyword.used).toBe(true);
    expect(body.contacts.map((c: { id: string }) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("finds indexed notes that the portable engine never reads", async () => {
    await reindexSearchIndex(fixture.conn);
    expect((await (await call("?q=pycon")).json()).total).toBe(0);
    const body = await (await call("?q=pycon&mode=keyword")).json();
    expect(body.contacts.map((c: { id: string }) => c.id)).toEqual(["c3"]);
  });

  it("reports the semantic arm as unconfigured instead of failing", async () => {
    await reindexSearchIndex(fixture.conn);
    const body = await (await call("?q=vercel&mode=hybrid")).json();
    // No EMBEDDINGS_* in the test environment.
    expect(body.engine.arms.semantic).toMatchObject({
      used: false,
      reason: "not_configured",
    });
    expect(body.engine.mode).toBe("keyword");
  });

  it("keeps filters and pagination working in keyword mode", async () => {
    await reindexSearchIndex(fixture.conn);
    const filtered = await (await call("?q=vercel&mode=keyword&seniority=junior")).json();
    expect(filtered.contacts.map((c: { id: string }) => c.id)).toEqual(["c3"]);

    const paged = await (await call("?q=vercel&mode=keyword&limit=1")).json();
    expect(paged.contacts).toHaveLength(1);
    expect(paged.total).toBe(2);
  });

  it("never leaks a credential into the response", async () => {
    await reindexSearchIndex(fixture.conn);
    const text = await (await call("?q=vercel&mode=hybrid")).text();
    expect(text).not.toMatch(/api[_-]?key|sk-|EMBEDDINGS_/i);
  });
});
