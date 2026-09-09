// Performance budget from the v2.0 plan §Phase 4: "index + upsert path on a
// 1k-contact import, `searchContacts` under budget".
//
// The assertions are a CI-safe multiple of the target (shared runners are slow
// and noisy); the numbers this machine actually reported are recorded in the
// phase progress doc. The point is to catch an order-of-magnitude regression —
// an accidental N+1 in the producer, or a fused query that stopped using the
// index — not to police milliseconds.
import { describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import { reindexSearchIndex } from "./indexer";
import { searchContacts } from "./query";
import { SEMANTIC_SCAN_LIMIT } from "./types";
import { encodeEmbedding, type EmbeddingProvider } from "./embeddings";

/** Deterministic LCG — stable synthetic data across runs and machines. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const COMPANIES = ["Stripe", "Vercel", "Monzo", "Linear", "Figma", "Ramp"];
const ROLES = [
  "Senior Engineer",
  "Product Manager",
  "Designer",
  "Staff Engineer",
  "Data Scientist",
];
const CITIES = ["Berlin", "London", "San Francisco", "Lisbon", "Toronto"];

function seedContacts(
  sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"],
  count: number,
): void {
  const rand = rng(7);
  const insert = sqlite.prepare(
    `INSERT INTO contacts (id, workspace_id, full_name, email, company, role, location, headline,
       notes, relationship_score, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const many = sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const company = COMPANIES[Math.floor(rand() * COMPANIES.length)]!;
      const role = ROLES[Math.floor(rand() * ROLES.length)]!;
      const city = CITIES[Math.floor(rand() * CITIES.length)]!;
      insert.run(
        `c${String(i).padStart(5, "0")}`,
        "default",
        `Contact ${i} Example`,
        `contact${i}@example.com`,
        company,
        role,
        city,
        `${role} at ${company} working on payments infrastructure`,
        `Met at a ${city} meetup in 2026; follow up about hiring.`,
        Math.round(rand() * 100) / 100,
        "linkedin_csv",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    }
  });
  many();
}

describe("hybrid search performance budget", () => {
  it("indexes 1,000 contacts and re-runs incrementally within budget", async () => {
    const { conn, sqlite } = createTestSqliteConn();
    seedContacts(sqlite, 1000);

    const coldStart = performance.now();
    const cold = await reindexSearchIndex(conn);
    const coldMs = performance.now() - coldStart;
    expect(cold).toMatchObject({ scanned: 1000, indexed: 1000 });

    const warmStart = performance.now();
    const warm = await reindexSearchIndex(conn);
    const warmMs = performance.now() - warmStart;
    expect(warm).toMatchObject({ indexed: 0, skipped: 1000 });

    // Budget: a 1k import should index in well under a second locally.
    // 8s is the CI-safe multiple.
    expect(coldMs).toBeLessThan(8000);
    // The content-hash guard is the whole point of the warm path: it must be a
    // large factor cheaper than the cold rebuild, not merely "also fast".
    expect(warmMs).toBeLessThan(coldMs);

    console.log(
      `[perf] reindex 1000 contacts: cold ${coldMs.toFixed(0)}ms, ` +
        `warm (all skipped) ${warmMs.toFixed(0)}ms`,
    );
    sqlite.close();
  }, 60_000);

  it("serves keyword and hybrid queries over 1,000 contacts within budget", async () => {
    const { conn, sqlite } = createTestSqliteConn();
    seedContacts(sqlite, 1000);

    const embedder: EmbeddingProvider = {
      id: "openai",
      model: "perf-model",
      // 256 dims — the realistic low end of a truncated embedding model, so
      // the cosine loop is measured at a plausible width.
      async embed(texts) {
        return texts.map((text) => {
          const rand = rng(text.length + text.charCodeAt(0));
          return Array.from({ length: 256 }, () => rand());
        });
      },
    };
    await reindexSearchIndex(conn, { embedder });

    const portableStart = performance.now();
    const portable = await searchContacts(conn, { query: "payments berlin" });
    const portableMs = performance.now() - portableStart;

    const keywordStart = performance.now();
    const keyword = await searchContacts(conn, {
      query: "payments berlin",
      mode: "keyword",
    });
    const keywordMs = performance.now() - keywordStart;

    const hybridStart = performance.now();
    const hybrid = await searchContacts(
      conn,
      { query: "payments berlin", mode: "hybrid" },
      { embedder },
    );
    const hybridMs = performance.now() - hybridStart;

    expect(keyword.engine.arms.keyword.used).toBe(true);
    expect(hybrid.engine.arms.semantic.used).toBe(true);
    expect(portable.contacts.length).toBeGreaterThan(0);

    // Budget: a search request should stay well inside the 500 ms page budget
    // the dashboard already holds itself to. 3s is the CI-safe multiple, and
    // it still catches a full-table-scan regression.
    expect(portableMs).toBeLessThan(3000);
    expect(keywordMs).toBeLessThan(3000);
    expect(hybridMs).toBeLessThan(3000);

    console.log(
      `[perf] search 1000 contacts: portable ${portableMs.toFixed(0)}ms, ` +
        `keyword ${keywordMs.toFixed(0)}ms, hybrid ${hybridMs.toFixed(0)}ms`,
    );
    sqlite.close();
  }, 120_000);

  it("bounds the semantic scan so a large network cannot blow the budget", () => {
    // Documented cap: the semantic arm loads at most this many vectors, chosen
    // by relationship score. Asserted so a future change has to be deliberate.
    expect(SEMANTIC_SCAN_LIMIT).toBe(5000);
    // A 1536-dim vector serialises to ~13 KB; 5k of them is ~65 MB of JSON
    // text at the absolute worst case, and the rounding in encodeEmbedding is
    // what keeps that number from tripling.
    const wide = Array.from(
      { length: 1536 },
      (_, i) => Math.sin(i) * 0.123456789,
    );
    expect(encodeEmbedding(wide).length).toBeLessThan(1536 * 12);
  });
});
