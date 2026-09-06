import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import type { SqliteConn } from "@netpro/db";
import { searchContacts } from "./query";

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
  relationshipScore?: number;
  lastInteraction?: string | null;
  deletedAt?: string | null;
}

const NOW = new Date("2026-09-06T12:00:00.000Z").toISOString();
const tenDaysAgo = new Date("2026-08-27T12:00:00.000Z").toISOString();
const hundredDaysAgo = new Date("2026-05-29T12:00:00.000Z").toISOString();

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
    relationshipScore: 0.8,
    lastInteraction: tenDaysAgo,
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
    relationshipScore: 0.5,
    lastInteraction: hundredDaysAgo,
  },
  {
    id: "c3",
    fullName: "Alice Wong",
    email: null,
    company: "Vercel",
    role: "Designer",
    seniority: "junior",
    industry: "Software",
    location: "Berlin",
    relationshipScore: 0.2,
    lastInteraction: null,
  },
  {
    id: "c4",
    fullName: "Bob Lee",
    email: "bob@stripe.com",
    company: "Stripe",
    role: "Engineering Manager",
    seniority: "lead",
    industry: "Fintech",
    location: "London",
    relationshipScore: 0.9,
    lastInteraction: tenDaysAgo,
  },
  {
    id: "c5",
    fullName: "Carol Diaz",
    email: "carol@example.com",
    company: "Independent",
    role: "Chief Technology Officer",
    seniority: "c_level",
    industry: "Consulting",
    location: "Madrid",
    relationshipScore: 0.1,
    lastInteraction: hundredDaysAgo,
  },
  {
    id: "c6",
    fullName: "Deleted Person",
    email: "ghost@example.com",
    company: "Stripe",
    role: "Engineer",
    seniority: "mid",
    industry: "Fintech",
    location: "Berlin",
    relationshipScore: 0.7,
    lastInteraction: tenDaysAgo,
    deletedAt: NOW,
  },
];

function seed(conn: SqliteConn): void {
  for (const s of SEED) {
    conn.db
      .insert(conn.schema.contacts)
      .values({
        id: s.id,
        fullName: s.fullName,
        email: s.email ?? null,
        company: s.company ?? null,
        role: s.role ?? null,
        seniority: s.seniority ?? null,
        industry: s.industry ?? null,
        location: s.location ?? null,
        headline: s.headline ?? null,
        relationshipScore: s.relationshipScore ?? 0,
        lastInteraction: s.lastInteraction ?? null,
        deletedAt: s.deletedAt ?? null,
        source: "linkedin_csv",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
}

describe("searchContacts", () => {
  let conn: SqliteConn;

  beforeEach(() => {
    conn = createTestConn();
    seed(conn);
  });

  it("returns all non-deleted contacts by default", async () => {
    const res = await searchContacts(conn);
    expect(res.total).toBe(5);
    expect(res.contacts).toHaveLength(5);
    expect(res.contacts.some((c) => c.id === "c6")).toBe(false);
  });

  it("matches free-text query across name/company/role case-insensitively", async () => {
    const byCompany = await searchContacts(conn, { query: "vercel" });
    expect(byCompany.contacts.map((c) => c.id).sort()).toEqual(["c2", "c3"]);

    const byName = await searchContacts(conn, { query: "JANE" });
    expect(byName.contacts.map((c) => c.id)).toEqual(["c1"]);

    // 'manager' is a substring of both "Engineering Manager" and "Product Manager"
    const byRole = await searchContacts(conn, { query: "manager" });
    expect(byRole.contacts.map((c) => c.id).sort()).toEqual(["c2", "c4"]);
  });

  it("requires every query term to match (AND across terms)", async () => {
    const res = await searchContacts(conn, { query: "stripe london" });
    expect(res.contacts.map((c) => c.id)).toEqual(["c4"]);
  });

  it("filters by company/role/location/industry as substring matches", async () => {
    const company = await searchContacts(conn, { company: "stripe" });
    expect(company.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);

    const location = await searchContacts(conn, { location: "ber" });
    expect(location.contacts.map((c) => c.id).sort()).toEqual(["c1", "c3"]);

    const industry = await searchContacts(conn, { industry: "fin" });
    expect(industry.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });

  it("filters by exact seniority", async () => {
    const senior = await searchContacts(conn, { seniority: "senior" });
    expect(senior.contacts.map((c) => c.id)).toEqual(["c1"]);

    const cLevel = await searchContacts(conn, { seniority: "c_level" });
    expect(cLevel.contacts.map((c) => c.id)).toEqual(["c5"]);
  });

  it("filters by hasEmail", async () => {
    const withEmail = await searchContacts(conn, { hasEmail: true });
    expect(withEmail.contacts.map((c) => c.id).sort()).toEqual([
      "c1",
      "c2",
      "c4",
      "c5",
    ]);
  });

  it("filters by minimum relationship score", async () => {
    const res = await searchContacts(conn, { minScore: 0.8 });
    expect(res.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);
  });

  it("filters by last-active window", async () => {
    const active30 = await searchContacts(conn, { lastActiveWithinDays: 30 });
    expect(active30.contacts.map((c) => c.id).sort()).toEqual(["c1", "c4"]);

    const active365 = await searchContacts(conn, { lastActiveWithinDays: 365 });
    // c3 has null lastInteraction and is excluded; everyone active within a year:
    expect(active365.contacts.map((c) => c.id).sort()).toEqual([
      "c1",
      "c2",
      "c4",
      "c5",
    ]);
  });

  it("paginates with limit/offset and reports the correct total", async () => {
    const page1 = await searchContacts(conn, {
      limit: 2,
      offset: 0,
      sort: "name",
    });
    expect(page1.contacts).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.contacts[0]?.fullName).toBe("Alice Wong");

    const page3 = await searchContacts(conn, {
      limit: 2,
      offset: 4,
      sort: "name",
    });
    expect(page3.contacts).toHaveLength(1);
    expect(page3.contacts[0]?.fullName).toBe("John Smith");
  });

  it("sorts by name, score, recent, and relevance", async () => {
    const byName = await searchContacts(conn, { sort: "name" });
    expect(byName.contacts.map((c) => c.fullName)).toEqual([
      "Alice Wong",
      "Bob Lee",
      "Carol Diaz",
      "Jane Doe",
      "John Smith",
    ]);

    const byScore = await searchContacts(conn, { sort: "score" });
    expect(byScore.contacts[0]?.id).toBe("c4"); // 0.9

    const byRecent = await searchContacts(conn, { sort: "recent" });
    // c1 and c4 share the same recent timestamp; name tiebreak orders Bob Lee before Jane Doe
    expect([byRecent.contacts[0]?.id, byRecent.contacts[1]?.id].sort()).toEqual(
      ["c1", "c4"],
    );
    expect(byRecent.contacts[0]?.id).toBe("c4");
    // contacts with no interaction (c3) sort last
    expect(byRecent.contacts[byRecent.contacts.length - 1]?.id).toBe("c3");

    const byRelevance = await searchContacts(conn, {
      query: "stripe",
      sort: "relevance",
    });
    // Both c1 and c4 are at Stripe; relevance ties (company match), score breaks it -> c4 (0.9)
    expect(byRelevance.contacts[0]?.id).toBe("c4");
  });

  it("ranks an exact name match above a company match for relevance", async () => {
    // "jane" matches c1 by NAME (rank 4); nothing else matches by name.
    const res = await searchContacts(conn, {
      query: "jane",
      sort: "relevance",
    });
    expect(res.contacts[0]?.id).toBe("c1");
  });

  it("returns facets for the active filter set", async () => {
    const res = await searchContacts(conn);
    const companies = Object.fromEntries(
      res.facets.company.map((b) => [b.value, b.count]),
    );
    expect(companies["stripe"]).toBe(2);
    expect(companies["vercel"]).toBe(2);

    const seniority = Object.fromEntries(
      res.facets.seniority.map((b) => [b.value, b.count]),
    );
    expect(seniority["senior"]).toBe(1);
    expect(seniority["lead"]).toBe(1);
  });

  it("facets respect the active filters", async () => {
    const res = await searchContacts(conn, { company: "stripe" });
    const companyValues = res.facets.company.map((b) => b.value);
    expect(companyValues).toEqual(["stripe"]);
  });
});
