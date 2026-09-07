import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import { reindexSearchIndex } from "@netpro/core/src/search";
import { engineLine, executeSearch, toSearchOptions } from "./search";
import type { SqliteConn } from "@netpro/db";

function createTestConn(): SqliteConn {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
      email TEXT, email_verified INTEGER DEFAULT 0, phone TEXT, avatar_url TEXT,
      headline TEXT, company TEXT, company_domain TEXT, role TEXT, seniority TEXT,
      department TEXT, industry TEXT, location TEXT, country TEXT, timezone TEXT,
      linkedin_url TEXT, github_url TEXT, twitter_url TEXT, website_url TEXT,
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT, skills TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  return { dialect: "sqlite", db, schema };
}

function seed(conn: SqliteConn): void {
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
      relationshipScore: 0.8,
    },
    {
      id: "c2",
      fullName: "John Smith",
      email: "john@vercel.com",
      company: "Vercel",
      role: "Product Manager",
      seniority: "mid",
      location: "San Francisco",
      relationshipScore: 0.5,
    },
    {
      id: "c3",
      fullName: "Alice Wong",
      email: null,
      company: "Vercel",
      role: "Designer",
      seniority: "junior",
      location: "Berlin",
      relationshipScore: 0.2,
    },
  ];
  for (const r of rows) {
    conn.db
      .insert(conn.schema.contacts)
      .values({ ...r, source: "linkedin_csv", createdAt: now, updatedAt: now })
      .run();
  }
}

describe("toSearchOptions", () => {
  it("maps flags to core options", () => {
    // Keys use camelCase — that's how Commander delivers the hyphenated
    // long flags (`--min-score` -> `minScore`, `--active-within` -> `activeWithin`).
    const opts = toSearchOptions({
      company: "Stripe",
      seniority: "senior",
      hasEmail: true,
      minScore: "0.5",
      activeWithin: "30",
      sort: "score",
      limit: "10",
      offset: "5",
    });
    expect(opts).toMatchObject({
      company: "Stripe",
      seniority: "senior",
      hasEmail: true,
      minScore: 0.5,
      lastActiveWithinDays: 30,
      sort: "score",
      limit: 10,
      offset: 5,
    });
  });

  it("rejects an unknown sort", () => {
    expect(() => toSearchOptions({ sort: "bogus" })).toThrow(/Unknown --sort/);
  });

  it("rejects an out-of-range min-score", () => {
    expect(() => toSearchOptions({ minScore: "2" })).toThrow(/between 0 and 1/);
  });

  it("rejects a non-numeric limit", () => {
    expect(() => toSearchOptions({ limit: "abc" })).toThrow(/must be a number/);
  });
});

describe("executeSearch", () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
    seed(conn);
  });

  it("returns matching contacts and a summary line", async () => {
    const output = await executeSearch({ query: "vercel" }, conn);
    expect(output).toContain("John Smith");
    expect(output).toContain("Alice Wong");
    expect(output).not.toContain("Jane Doe");
    expect(output).toContain("of 2 contacts");
  });

  it("applies filters", async () => {
    const output = await executeSearch({ company: "stripe" }, conn);
    expect(output).toContain("Jane Doe");
    expect(output).not.toContain("John Smith");
  });

  it("reports no matches cleanly", async () => {
    const output = await executeSearch({ query: "nonexistent" }, conn);
    expect(output).toContain("No contacts match");
  });

  it("emits JSON when --json is set", async () => {
    const output = await executeSearch({ json: true, company: "vercel" }, conn);
    const parsed = JSON.parse(output);
    expect(parsed.total).toBe(2);
    expect(Array.isArray(parsed.contacts)).toBe(true);
    expect(parsed.facets).toBeDefined();
  });
});

// ── v2.0 Phase 4: hybrid search flags ────────────────────────────────────

describe("toSearchOptions — mode selection", () => {
  it("leaves mode undefined by default (portable stays the default)", () => {
    expect(toSearchOptions({}).mode).toBeUndefined();
  });

  it("maps --semantic to hybrid", () => {
    expect(toSearchOptions({ semantic: true }).mode).toBe("hybrid");
  });

  it.each(["portable", "keyword", "hybrid"] as const)("accepts --mode %s", (mode) => {
    expect(toSearchOptions({ mode }).mode).toBe(mode);
  });

  it("lets an explicit --mode win over --semantic", () => {
    expect(toSearchOptions({ mode: "keyword", semantic: true }).mode).toBe("keyword");
  });

  it("rejects an unknown --mode with the valid list", () => {
    expect(() => toSearchOptions({ mode: "vector" })).toThrow(
      /Unknown --mode "vector".*portable, keyword, hybrid/s,
    );
  });
});

describe("engineLine", () => {
  const base = {
    mode: "keyword" as const,
    requested: "keyword" as const,
    arms: {
      portable: { used: true, hits: 3 },
      keyword: { used: true, hits: 5 },
      semantic: { used: false, hits: 0, reason: "not_requested" as const },
    },
    truncated: false,
  };

  it("prints nothing for a portable request — v1 output is unchanged", () => {
    expect(engineLine({ ...base, requested: "portable" })).toBeNull();
  });

  it("summarises the arms that ran", () => {
    expect(engineLine(base)).toBe("Engine: keyword — full-text 5, substring 3");
  });

  it("explains a dropped keyword arm actionably", () => {
    expect(
      engineLine({
        ...base,
        mode: "portable",
        arms: { ...base.arms, keyword: { used: false, hits: 0, reason: "index_empty" } },
      }),
    ).toContain("full-text off (index empty; run netpro reindex)");
  });

  it("explains a missing index as a migration problem", () => {
    expect(
      engineLine({
        ...base,
        arms: { ...base.arms, keyword: { used: false, hits: 0, reason: "index_missing" } },
      }),
    ).toContain("run netpro migrate");
  });

  it.each([
    ["not_configured", "no embeddings key"],
    ["no_embeddings", "no vectors; run netpro reindex --embeddings"],
    ["provider_error", "provider error"],
  ] as const)("explains semantic reason %s", (reason, label) => {
    const line = engineLine({
      ...base,
      requested: "hybrid",
      arms: { ...base.arms, semantic: { used: false, hits: 0, reason } },
    });
    expect(line).toContain(`semantic off (${label})`);
  });

  it("flags a capped candidate pool", () => {
    expect(engineLine({ ...base, truncated: true })).toContain("candidate pool capped");
  });
});

describe("executeSearch — hybrid output", () => {
  let migrated: SqliteConn;
  let migratedSqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

  beforeEach(async () => {
    const created = createTestSqliteConn();
    migrated = created.conn;
    migratedSqlite = created.sqlite;
    migratedSqlite
      .prepare(
        `INSERT INTO contacts (id, full_name, email, company, role, notes, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "c1",
        "Jane Doe",
        "jane@stripe.com",
        "Stripe",
        "Senior Engineer",
        "Introduced at PyCon",
        "manual",
        "2026-01-01",
        "2026-01-01",
      );
    await reindexSearchIndex(migrated);
  });

  it("appends the engine line for a keyword run", async () => {
    const output = await executeSearch({ query: "stripe", mode: "keyword" }, migrated);
    expect(output).toContain("Jane Doe");
    expect(output).toContain("Engine: keyword — full-text 1, substring 1");
  });

  it("finds an indexed-notes match the portable engine cannot", async () => {
    expect(await executeSearch({ query: "pycon" }, migrated)).toContain("No contacts match");
    const output = await executeSearch({ query: "pycon", mode: "keyword" }, migrated);
    expect(output).toContain("Jane Doe");
  });

  it("still prints the engine line when nothing matched", async () => {
    const output = await executeSearch({ query: "zzznope", mode: "keyword" }, migrated);
    expect(output).toContain("No contacts match");
    expect(output).toContain("Engine:");
  });

  it("reports the semantic arm as unconfigured rather than failing", async () => {
    const output = await executeSearch(
      { query: "stripe", mode: "hybrid" },
      migrated,
      { embedder: { embedder: null } },
    );
    expect(output).toContain("semantic off (no embeddings key)");
  });

  it("carries the engine report through --json", async () => {
    const output = await executeSearch(
      { query: "stripe", mode: "keyword", json: true },
      migrated,
    );
    const parsed = JSON.parse(output);
    expect(parsed.engine).toMatchObject({ mode: "keyword", requested: "keyword" });
    expect(parsed.engine.arms.keyword.used).toBe(true);
  });

  it("keeps portable output free of any engine chatter", async () => {
    const output = await executeSearch({ query: "stripe" }, migrated);
    expect(output).toContain("Jane Doe");
    expect(output).not.toContain("Engine:");
  });
});
