import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import { executeSearch, toSearchOptions } from "./search";
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
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT,
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
