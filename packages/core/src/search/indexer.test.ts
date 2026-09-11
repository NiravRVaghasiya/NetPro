import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { SqliteConn } from "@netpro/db";
import {
  buildSearchDocument,
  hashContent,
  keywordIndexAvailable,
  MAX_SEARCH_TEXT_CHARS,
  reindexSearchIndex,
  searchIndexStatus,
} from "./indexer";
import { encodeEmbedding, type EmbeddingProvider } from "./embeddings";

let conn: SqliteConn;
let sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

function insertContact(
  id: string,
  fields: Partial<{
    fullName: string;
    email: string | null;
    headline: string | null;
    company: string | null;
    role: string | null;
    seniority: string | null;
    industry: string | null;
    location: string | null;
    notes: string | null;
    tags: string | null;
    deletedAt: string | null;
  }> = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO contacts (id, workspace_id, full_name, email, headline, company, role, seniority,
         industry, location, notes, tags, source, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "default",
      fields.fullName ?? `Contact ${id}`,
      fields.email ?? null,
      fields.headline ?? null,
      fields.company ?? null,
      fields.role ?? null,
      fields.seniority ?? null,
      fields.industry ?? null,
      fields.location ?? null,
      fields.notes ?? null,
      fields.tags ?? null,
      "manual",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      fields.deletedAt ?? null,
    );
}

/** Deterministic offline embedder: one dimension per keyword, no network. */
function fakeEmbedder(
  model = "fake-model",
): EmbeddingProvider & { calls: string[][] } {
  const vocabulary = ["payments", "design", "berlin", "growth"];
  const calls: string[][] = [];
  return {
    id: "openai",
    model,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return texts.map((t) => vocabulary.map((w) => (t.includes(w) ? 1 : 0)));
    },
  };
}

beforeEach(() => {
  const created = createTestSqliteConn();
  conn = created.conn;
  sqlite = created.sqlite;
});

describe("buildSearchDocument", () => {
  it("folds every searchable field into one lowercased document", () => {
    const doc = buildSearchDocument({
      id: "c1",
      fullName: "Jane Doe",
      email: "jane@stripe.com",
      headline: "Payments infrastructure",
      company: "Stripe",
      role: "Senior Engineer",
      seniority: "senior",
      department: "Engineering",
      industry: "Fintech",
      location: "Berlin",
      country: "DE",
      notes: "Met at PyCon",
      tags: '["mentor","fintech"]',
      skills: ["python", "kubernetes"],
    });
    expect(doc.searchText).toBe(
      "jane doe jane@stripe.com payments infrastructure stripe senior engineer " +
        "senior engineering fintech berlin de mentor fintech python kubernetes met at pycon",
    );
    expect(doc.companyNorm).toBe("stripe");
    expect(doc.roleNorm).toBe("senior engineer");
    expect(doc.locationNorm).toBe("berlin");
    expect(doc.seniorityNorm).toBe("senior");
    expect(doc.industryNorm).toBe("fintech");
  });

  it("skips blanks, collapses whitespace, and normalizes empty facets to null", () => {
    const doc = buildSearchDocument({
      id: "c1",
      fullName: "  Ann   Lee  ",
      company: "   ",
      role: null,
    });
    expect(doc.searchText).toBe("ann lee");
    expect(doc.companyNorm).toBeNull();
    expect(doc.roleNorm).toBeNull();
  });

  it.each([
    ["json array", '["a","b"]', "a b"],
    ["already parsed", ["a", "b"], "a b"],
    ["bare string", "mentor", "mentor"],
    ["malformed json", "{oops", "{oops"],
    ["non-strings", '[1,{"x":2}]', ""],
    ["null", null, ""],
  ])("accepts %s tags", (_label, tags, expected) => {
    const doc = buildSearchDocument({ id: "c1", fullName: "X", tags });
    expect(doc.searchText).toBe(expected ? `x ${expected}` : "x");
  });

  it("caps a pathological notes blob", () => {
    const doc = buildSearchDocument({
      id: "c1",
      fullName: "X",
      notes: "y".repeat(MAX_SEARCH_TEXT_CHARS * 2),
    });
    expect(doc.searchText).toHaveLength(MAX_SEARCH_TEXT_CHARS);
  });

  it("hashes content stably and distinguishes changes", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("")).toHaveLength(16);
  });
});

describe("reindexSearchIndex", () => {
  it("writes one row per live contact and mirrors it into FTS5", async () => {
    insertContact("c1", { fullName: "Jane Doe", company: "Stripe" });
    insertContact("c2", { fullName: "John Smith", company: "Acme" });

    const summary = await reindexSearchIndex(conn);
    expect(summary).toMatchObject({
      scanned: 2,
      indexed: 2,
      skipped: 0,
      embedded: 0,
    });

    const rows = sqlite
      .prepare(
        "SELECT contact_id, search_text, content_hash FROM search_index ORDER BY contact_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    const fts = sqlite
      .prepare("SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?")
      .all("stripe");
    expect(fts).toEqual([{ contact_id: "c1" }]);
  });

  it("is idempotent — a second run skips every unchanged row", async () => {
    insertContact("c1", { fullName: "Jane Doe" });
    await reindexSearchIndex(conn);
    const second = await reindexSearchIndex(conn);
    expect(second).toMatchObject({ scanned: 1, indexed: 0, skipped: 1 });
  });

  it("re-writes a row whose content changed and keeps FTS in step", async () => {
    insertContact("c1", { fullName: "Jane Doe", company: "Stripe" });
    await reindexSearchIndex(conn);
    sqlite
      .prepare("UPDATE contacts SET company = 'Acme' WHERE id = 'c1'")
      .run();

    const summary = await reindexSearchIndex(conn);
    expect(summary).toMatchObject({ indexed: 1, skipped: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?",
        )
        .all("stripe"),
    ).toEqual([]);
    expect(
      sqlite
        .prepare(
          "SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?",
        )
        .all("acme"),
    ).toEqual([{ contact_id: "c1" }]);
  });

  it("--force rewrites even unchanged rows", async () => {
    insertContact("c1");
    await reindexSearchIndex(conn);
    expect(await reindexSearchIndex(conn, { force: true })).toMatchObject({
      indexed: 1,
      skipped: 0,
    });
  });

  it("prunes a soft-deleted contact out of the index and out of FTS", async () => {
    insertContact("c1", { fullName: "Jane Doe", company: "Stripe" });
    await reindexSearchIndex(conn);
    sqlite
      .prepare("UPDATE contacts SET deleted_at = '2026-02-01' WHERE id = 'c1'")
      .run();

    const summary = await reindexSearchIndex(conn);
    expect(summary).toMatchObject({ scanned: 0, pruned: 1 });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?",
        )
        .all("stripe"),
    ).toEqual([]);
  });

  it("scopes a targeted reindex — and cannot prune out-of-scope rows", async () => {
    insertContact("c1", { fullName: "Jane Doe" });
    insertContact("c2", { fullName: "John Smith" });
    await reindexSearchIndex(conn);
    sqlite
      .prepare("UPDATE contacts SET deleted_at = '2026-02-01' WHERE id = 'c2'")
      .run();

    const summary = await reindexSearchIndex(conn, { contactIds: ["c1"] });
    expect(summary).toMatchObject({ scanned: 1, pruned: 0 });
    // c2 is soft-deleted but out of scope, so its row survives this run.
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 2 });
  });

  it("no-ops on an empty contactIds list rather than reindexing everything", async () => {
    insertContact("c1");
    expect(await reindexSearchIndex(conn, { contactIds: [] })).toMatchObject({
      scanned: 0,
      indexed: 0,
    });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 0 });
  });

  it("honours the limit cap", async () => {
    insertContact("c1");
    insertContact("c2");
    insertContact("c3");
    expect(await reindexSearchIndex(conn, { limit: 2 })).toMatchObject({
      scanned: 2,
    });
  });
});

describe("reindexSearchIndex — embeddings", () => {
  it("stores the vector, model and dimension when a provider is supplied", async () => {
    insertContact("c1", { fullName: "Jane", headline: "payments" });
    const embedder = fakeEmbedder();

    const summary = await reindexSearchIndex(conn, { embedder });
    expect(summary).toMatchObject({
      indexed: 1,
      embedded: 1,
      embeddingError: null,
    });

    const row = sqlite
      .prepare(
        "SELECT embedding, embedding_model, embedding_dim, embedding_updated_at FROM search_index",
      )
      .get() as Record<string, unknown>;
    expect(row.embedding).toBe(encodeEmbedding([1, 0, 0, 0]));
    expect(row.embedding_model).toBe("fake-model");
    expect(row.embedding_dim).toBe(4);
    expect(row.embedding_updated_at).toEqual(expect.any(String));
  });

  it("does not re-embed unchanged contacts (the cost guard)", async () => {
    insertContact("c1", { fullName: "Jane", headline: "payments" });
    const embedder = fakeEmbedder();
    await reindexSearchIndex(conn, { embedder });
    expect(embedder.calls).toHaveLength(1);

    const second = await reindexSearchIndex(conn, { embedder });
    expect(second).toMatchObject({ skipped: 1, embedded: 0 });
    expect(embedder.calls).toHaveLength(1);
  });

  it("re-embeds when the model changes — vectors from two models never mix", async () => {
    insertContact("c1", { fullName: "Jane", headline: "payments" });
    await reindexSearchIndex(conn, { embedder: fakeEmbedder("model-a") });

    const summary = await reindexSearchIndex(conn, {
      embedder: fakeEmbedder("model-b"),
    });
    expect(summary).toMatchObject({ indexed: 1, embedded: 1 });
    expect(
      (
        sqlite
          .prepare("SELECT embedding_model AS m FROM search_index")
          .get() as { m: string }
      ).m,
    ).toBe("model-b");
  });

  it("a keyword-only rerun preserves an existing vector", async () => {
    insertContact("c1", { fullName: "Jane", headline: "payments" });
    await reindexSearchIndex(conn, { embedder: fakeEmbedder() });
    sqlite
      .prepare("UPDATE contacts SET company = 'Stripe' WHERE id = 'c1'")
      .run();

    await reindexSearchIndex(conn); // no embedder
    const row = sqlite
      .prepare(
        "SELECT embedding, embedding_model, search_text FROM search_index",
      )
      .get() as Record<string, string>;
    expect(row.embedding).toBe(encodeEmbedding([1, 0, 0, 0]));
    expect(row.embedding_model).toBe("fake-model");
    expect(row.search_text).toContain("stripe");
  });

  it("batches large runs", async () => {
    for (let i = 0; i < 70; i++)
      insertContact(`c${String(i).padStart(3, "0")}`);
    const embedder = fakeEmbedder();
    const summary = await reindexSearchIndex(conn, { embedder });
    expect(summary.embedded).toBe(70);
    expect(embedder.calls.map((c) => c.length)).toEqual([64, 6]);
  });

  it("keeps the keyword index when embeddings fail mid-run", async () => {
    insertContact("c1", { fullName: "Jane", company: "Stripe" });
    const embedder: EmbeddingProvider = {
      id: "openai",
      model: "boom",
      embed: vi.fn(async () => {
        throw new Error("upstream 503");
      }),
    };

    const summary = await reindexSearchIndex(conn, { embedder });
    expect(summary.indexed).toBe(1);
    expect(summary.embedded).toBe(0);
    expect(summary.embeddingError).toMatch(/upstream 503/);
    // The point of the degradation: full-text search still works.
    expect(
      sqlite
        .prepare(
          "SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?",
        )
        .all("stripe"),
    ).toEqual([{ contact_id: "c1" }]);
  });
});

describe("searchIndexStatus", () => {
  it("reports coverage, models, and index availability", async () => {
    insertContact("c1", { fullName: "Jane", headline: "payments" });
    insertContact("c2", { fullName: "John" });
    insertContact("c3", { fullName: "Gone", deletedAt: "2026-02-01" });

    expect(await searchIndexStatus(conn)).toEqual({
      contacts: 2,
      indexed: 0,
      embedded: 0,
      embeddingModels: [],
      keywordIndexAvailable: true,
    });

    await reindexSearchIndex(conn, { embedder: fakeEmbedder() });
    expect(await searchIndexStatus(conn)).toEqual({
      contacts: 2,
      indexed: 2,
      // "John" contains no vocabulary word, so his vector is all zeros — still
      // stored: absence of signal is not absence of an embedding.
      embedded: 2,
      embeddingModels: ["fake-model"],
      keywordIndexAvailable: true,
    });
  });

  it("reports the keyword index as unavailable on an unmigrated database", async () => {
    conn.db.run(sql`DROP TABLE contacts_fts`);
    expect(await keywordIndexAvailable(conn)).toBe(false);
  });
});
