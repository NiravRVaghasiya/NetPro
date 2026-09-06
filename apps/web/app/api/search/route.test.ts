import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";

vi.mock("@/lib/db", () => {
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
    },
  ];
  for (const r of rows) {
    db.insert(schema.contacts)
      .values({ ...r, source: "linkedin_csv", createdAt: now, updatedAt: now })
      .run();
  }
  return { conn: { dialect: "sqlite", db, schema } };
});

const { GET } = await import("./route");

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
