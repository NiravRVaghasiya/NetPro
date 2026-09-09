import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { SqliteConn } from "@netpro/db";
import { searchContacts } from "./query";
import { reindexSearchIndex } from "./indexer";
import { buildFts5Query, buildTsQuery } from "./arms";
import { HYBRID_POOL_LIMIT } from "./types";
import type { EmbeddingProvider } from "./embeddings";

let conn: SqliteConn;
let sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

interface Seed {
  id: string;
  fullName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  seniority?: string | null;
  industry?: string | null;
  location?: string | null;
  headline?: string | null;
  notes?: string | null;
  score?: number;
  lastInteraction?: string | null;
}

const SEED: Seed[] = [
  {
    id: "c1",
    fullName: "Jane Doe",
    email: "jane@stripe.com",
    company: "Stripe",
    role: "Senior Engineer",
    seniority: "senior",
    industry: "Fintech",
    location: "Berlin",
    headline: "Payments infrastructure",
    score: 0.8,
    lastInteraction: "2026-08-27T12:00:00.000Z",
  },
  {
    id: "c2",
    fullName: "John Smith",
    email: "john@vercel.com",
    company: "Vercel",
    role: "Product Manager",
    seniority: "mid",
    industry: "Software",
    location: "San Francisco",
    headline: "Building the web",
    score: 0.5,
    lastInteraction: "2026-05-29T12:00:00.000Z",
  },
  {
    id: "c3",
    fullName: "Alice Wong",
    company: "Vercel",
    role: "Designer",
    seniority: "junior",
    industry: "Software",
    location: "Berlin",
    headline: "Design systems",
    score: 0.3,
  },
  {
    id: "c4",
    fullName: "Stephanie Nguyen",
    email: "steph@monzo.com",
    company: "Monzo",
    role: "Staff Engineer",
    seniority: "lead",
    industry: "Fintech",
    location: "London",
    headline: "Card issuing and payments",
    notes: "Introduced by Jane",
    score: 0.6,
  },
];

function seed(rows: Seed[] = SEED): void {
  const stmt = sqlite.prepare(
    `INSERT INTO contacts (id, workspace_id, full_name, email, company, role, seniority, industry,
       location, headline, notes, relationship_score, last_interaction,
       source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      "default",
      r.fullName,
      r.email ?? null,
      r.company ?? null,
      r.role ?? null,
      r.seniority ?? null,
      r.industry ?? null,
      r.location ?? null,
      r.headline ?? null,
      r.notes ?? null,
      r.score ?? 0,
      r.lastInteraction ?? null,
      "manual",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  }
}

/** Offline embedder: a topic vector, so semantic hits are hand-predictable. */
const TOPICS = ["payments", "design", "management"];
function topicEmbedder(model = "fake-model"): EmbeddingProvider {
  const lexicon: Record<string, number[]> = {
    payments: [1, 0, 0],
    fintech: [1, 0, 0],
    card: [1, 0, 0],
    stripe: [1, 0, 0],
    monzo: [1, 0, 0],
    design: [0, 1, 0],
    designer: [0, 1, 0],
    systems: [0, 1, 0],
    product: [0, 0, 1],
    manager: [0, 0, 1],
    roadmap: [0, 0, 1],
  };
  return {
    id: "openai",
    model,
    async embed(texts: string[]) {
      return texts.map((text) => {
        const vector = [0, 0, 0];
        for (const word of text.toLowerCase().split(/[^a-z]+/)) {
          const hit = lexicon[word];
          if (hit)
            for (let i = 0; i < TOPICS.length; i++) vector[i]! += hit[i]!;
        }
        return vector;
      });
    },
  };
}

beforeEach(() => {
  const created = createTestSqliteConn();
  conn = created.conn;
  sqlite = created.sqlite;
});

// ── Query-string builders ────────────────────────────────────────────────

describe("keyword query builders", () => {
  it("quotes and prefix-matches each FTS5 term", () => {
    expect(buildFts5Query(["jane", "doe"])).toBe('"jane"* AND "doe"*');
  });

  it("neutralizes FTS5 operators that would otherwise be a syntax error", () => {
    // Unquoted, each of these is an operator or a syntax error in FTS5.
    expect(buildFts5Query(["AND"])).toBe('"AND"*');
    expect(buildFts5Query(["NEAR(a b)"])).toBe('"NEAR(a b)"*');
    expect(buildFts5Query(['say "hi"'])).toBe('"say ""hi"""*');
    expect(buildFts5Query(["c++"])).toBe('"c++"*');
  });

  it("drops terms with nothing indexable and returns null when all are dropped", () => {
    expect(buildFts5Query(["***", "jane"])).toBe('"jane"*');
    expect(buildFts5Query(["***", "-"])).toBeNull();
    expect(buildFts5Query([])).toBeNull();
  });

  it("sanitizes tsquery input down to literal lexemes", () => {
    expect(buildTsQuery(["jane", "doe"])).toBe("jane:* & doe:*");
    // `&`, `|`, `!`, `(` and `:` are tsquery grammar — they must not survive.
    expect(buildTsQuery(["a&b|c!(d)"])).toBe("a:* & b:* & c:* & d:*");
    expect(buildTsQuery(["jane@stripe.com"])).toBe("jane@stripe.com:*");
    expect(buildTsQuery(["!!!"])).toBeNull();
  });
});

// ── Portable default ─────────────────────────────────────────────────────

describe("searchContacts — portable stays the default", () => {
  it("reports the portable engine and runs no arms when mode is omitted", async () => {
    seed();
    const res = await searchContacts(conn, { query: "vercel" });
    expect(res.engine.mode).toBe("portable");
    expect(res.engine.requested).toBe("portable");
    expect(res.engine.arms.keyword.used).toBe(false);
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("degrades a keyword request with no free text to portable", async () => {
    seed();
    const res = await searchContacts(conn, {
      mode: "hybrid",
      company: "vercel",
    });
    expect(res.engine.mode).toBe("portable");
    expect(res.engine.requested).toBe("hybrid");
    expect(res.engine.arms.keyword.reason).toBe("not_requested");
    expect(res.total).toBe(2);
  });
});

// ── Keyword arm ──────────────────────────────────────────────────────────

describe("searchContacts — keyword mode", () => {
  beforeEach(async () => {
    seed();
    await reindexSearchIndex(conn);
  });

  it("fuses the FTS arm with the portable arm", async () => {
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
    });
    expect(res.engine.mode).toBe("keyword");
    expect(res.engine.arms.keyword.used).toBe(true);
    expect(res.engine.arms.portable.used).toBe(true);
    expect(res.engine.arms.semantic.reason).toBe("not_requested");
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });

  it("prefix-matches — the substring engine's blind spot for left anchors", async () => {
    // "steph" is a prefix of "Stephanie": both engines find her here, but the
    // keyword arm finds her by token prefix at index speed.
    const res = await searchContacts(conn, { query: "steph", mode: "keyword" });
    expect(res.contacts.map((c) => c.id)).toContain("c4");
    expect(res.engine.arms.keyword.hits).toBeGreaterThan(0);
  });

  it("finds a contact the substring engine misses (indexed notes)", async () => {
    // `notes` is indexed but is NOT one of the portable engine's searchable
    // columns, so this row can only come from the keyword arm.
    const portable = await searchContacts(conn, { query: "introduced" });
    expect(portable.contacts).toHaveLength(0);

    const keyword = await searchContacts(conn, {
      query: "introduced",
      mode: "keyword",
    });
    expect(keyword.contacts.map((c) => c.id)).toEqual(["c4"]);
    expect(keyword.engine.arms.keyword.hits).toBe(1);
    expect(keyword.engine.arms.portable.hits).toBe(0);
  });

  it("is never worse than portable — the substring arm still contributes", async () => {
    // "erce" matches "Vercel" as a substring but not as a token prefix, so
    // only the portable arm can find it. Hybrid must still return it.
    const portable = await searchContacts(conn, { query: "erce" });
    const keyword = await searchContacts(conn, {
      query: "erce",
      mode: "keyword",
    });
    expect(portable.contacts.map((c) => c.id).sort()).toEqual(["c2", "c3"]);
    expect(keyword.contacts.map((c) => c.id).sort()).toEqual(["c2", "c3"]);
    expect(keyword.engine.arms.keyword.hits).toBe(0);
  });

  it("applies structured filters inside every arm", async () => {
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
      industry: "fintech",
      location: "london",
    });
    expect(res.contacts.map((c) => c.id)).toEqual(["c4"]);
    expect(res.total).toBe(1);
  });

  it("respects minScore, hasEmail and activity filters exactly as portable does", async () => {
    for (const filters of [
      { minScore: 0.7 },
      { hasEmail: true },
      { lastActiveWithinDays: 30 },
      { seniority: "senior" },
    ] as const) {
      const portable = await searchContacts(conn, { query: "e", ...filters });
      const hybrid = await searchContacts(conn, {
        query: "e",
        mode: "keyword",
        ...filters,
      });
      expect(new Set(hybrid.contacts.map((c) => c.id))).toEqual(
        new Set(portable.contacts.map((c) => c.id)),
      );
    }
  });

  it("never returns a soft-deleted contact", async () => {
    sqlite
      .prepare("UPDATE contacts SET deleted_at = '2026-02-01' WHERE id = 'c1'")
      .run();
    // The index row is stale on purpose: the filter must exclude her anyway.
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
    });
    expect(res.contacts.map((c) => c.id)).toEqual(["c4"]);
  });

  it("paginates the fused order coherently", async () => {
    const all = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      limit: 100,
    });
    const page1 = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      limit: 2,
    });
    const page2 = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      limit: 2,
      offset: 2,
    });

    expect(page1.total).toBe(all.total);
    expect(page1.contacts).toHaveLength(2);
    expect([...page1.contacts, ...page2.contacts].map((c) => c.id)).toEqual(
      all.contacts
        .slice(0, page1.contacts.length + page2.contacts.length)
        .map((c) => c.id),
    );
    // No overlap between pages.
    expect(
      page1.contacts.filter((c) => page2.contacts.some((o) => o.id === c.id)),
    ).toHaveLength(0);
  });

  it("is deterministic across repeated identical queries", async () => {
    const a = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      limit: 100,
    });
    const b = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      limit: 100,
    });
    expect(a.contacts.map((c) => c.id)).toEqual(b.contacts.map((c) => c.id));
  });

  it("honours a non-relevance sort over the fused candidate set", async () => {
    const res = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      sort: "name",
      limit: 100,
    });
    const names = res.contacts.map((c) => c.fullName);
    expect(names).toEqual([...names].sort());

    const byScore = await searchContacts(conn, {
      query: "e",
      mode: "keyword",
      sort: "score",
      limit: 100,
    });
    const scores = byScore.contacts.map((c) => c.relationshipScore ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("computes facets over the fused set, not the whole table", async () => {
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
    });
    const companies = res.facets.company.map((f) => f.value).sort();
    expect(companies).toEqual(["monzo", "stripe"]);
  });

  it("returns an empty, honest response when nothing matches", async () => {
    const res = await searchContacts(conn, {
      query: "zzzznomatch",
      mode: "keyword",
    });
    expect(res.contacts).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.facets.company).toEqual([]);
    expect(res.engine.mode).toBe("keyword");
  });

  it("reports index_empty when nothing has been indexed yet", async () => {
    sqlite.prepare("DELETE FROM search_index").run();
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
    });
    expect(res.engine.arms.keyword).toMatchObject({
      used: false,
      reason: "index_empty",
    });
    expect(res.engine.mode).toBe("portable");
    // Degrades to exactly what portable would have returned.
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });

  it("reports index_missing on an unmigrated database instead of throwing", async () => {
    conn.db.run(sql`DROP TABLE contacts_fts`);
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "keyword",
    });
    expect(res.engine.arms.keyword).toMatchObject({
      used: false,
      reason: "index_missing",
    });
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });
});

// ── Semantic arm ─────────────────────────────────────────────────────────

describe("searchContacts — hybrid mode", () => {
  beforeEach(() => seed());

  it("skips the semantic arm when embeddings are not configured", async () => {
    await reindexSearchIndex(conn);
    const res = await searchContacts(conn, {
      query: "payments",
      mode: "hybrid",
    });
    expect(res.engine.arms.semantic).toMatchObject({
      used: false,
      reason: "not_configured",
    });
    expect(res.engine.mode).toBe("keyword");
  });

  it("reports no_embeddings when the index has no vectors", async () => {
    await reindexSearchIndex(conn); // keyword only
    const res = await searchContacts(
      conn,
      { query: "payments", mode: "hybrid" },
      { embedder: topicEmbedder() },
    );
    expect(res.engine.arms.semantic).toMatchObject({
      used: false,
      reason: "no_embeddings",
    });
  });

  it("surfaces a conceptual match the lexical arms cannot find", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder() });
    // "monzo" appears in no contact's *searchable* text except c4's email, and
    // the query word itself is the topic anchor: the semantic arm maps it onto
    // the fintech/payments topic that c1 also carries.
    const res = await searchContacts(
      conn,
      { query: "roadmap", mode: "hybrid" },
      { embedder: topicEmbedder() },
    );
    expect(res.engine.mode).toBe("hybrid");
    expect(res.engine.arms.semantic.used).toBe(true);
    // c2 is the Product Manager — nothing lexical matches "roadmap".
    expect(res.contacts.map((c) => c.id)).toEqual(["c2"]);
    const lexical = await searchContacts(conn, {
      query: "roadmap",
      mode: "keyword",
    });
    expect(lexical.contacts).toEqual([]);
  });

  it("ranks the arms' agreement first", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder() });
    const res = await searchContacts(
      conn,
      { query: "payments", mode: "hybrid", limit: 100 },
      { embedder: topicEmbedder() },
    );
    // c1 and c4 are found by both the lexical and the semantic arms; c2/c3 at
    // most by one, so they cannot outrank them.
    expect(
      res.contacts
        .slice(0, 2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c1", "c4"]);
  });

  it("falls back to the lexical arms when the provider is down", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder() });
    const broken: EmbeddingProvider = {
      id: "openai",
      model: "fake-model",
      async embed() {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const res = await searchContacts(
      conn,
      { query: "payments", mode: "hybrid" },
      { embedder: broken },
    );
    expect(res.engine.arms.semantic).toMatchObject({
      used: false,
      reason: "provider_error",
    });
    expect(res.engine.arms.semantic.detail).toMatch(/ECONNREFUSED/);
    expect(res.engine.mode).toBe("keyword");
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });

  it("ignores vectors stored under a different model", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder("model-a") });
    const res = await searchContacts(
      conn,
      { query: "payments", mode: "hybrid" },
      { embedder: topicEmbedder("model-b") },
    );
    expect(res.engine.arms.semantic).toMatchObject({
      used: false,
      reason: "no_embeddings",
    });
  });

  it("skips a stored vector whose dimensions no longer match", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder() });
    sqlite
      .prepare(
        "UPDATE search_index SET embedding = '[1,2]' WHERE contact_id = 'c1'",
      )
      .run();
    const res = await searchContacts(
      conn,
      { query: "payments", mode: "hybrid", limit: 100 },
      { embedder: topicEmbedder() },
    );
    // No throw, and c1 is still present via the lexical arms.
    expect(res.contacts.map((c) => c.id)).toContain("c1");
    expect(res.engine.arms.semantic.used).toBe(true);
  });

  it("applies structured filters to the semantic arm too", async () => {
    await reindexSearchIndex(conn, { embedder: topicEmbedder() });
    const res = await searchContacts(
      conn,
      { query: "roadmap", mode: "hybrid", location: "berlin" },
      { embedder: topicEmbedder() },
    );
    // c2 (San Francisco) is the only semantic hit and the filter excludes him.
    expect(res.contacts).toEqual([]);
  });
});

// ── Bounds ───────────────────────────────────────────────────────────────

describe("searchContacts — fusion bounds", () => {
  it("caps the candidate pool and flags the response as truncated", async () => {
    const many: Seed[] = [];
    for (let i = 0; i < HYBRID_POOL_LIMIT + 25; i++) {
      many.push({
        id: `x${String(i).padStart(4, "0")}`,
        fullName: `Pat Example ${i}`,
        company: "Acme",
      });
    }
    seed(many);
    await reindexSearchIndex(conn);

    const res = await searchContacts(conn, {
      query: "acme",
      mode: "keyword",
      limit: 10,
    });
    expect(res.total).toBe(HYBRID_POOL_LIMIT);
    expect(res.engine.truncated).toBe(true);
    expect(res.contacts).toHaveLength(10);
  }, 20_000);
});
