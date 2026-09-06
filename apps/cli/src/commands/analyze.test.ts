import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import {
  executeAnalyze,
  selectedSection,
  toAnalyzeOptions,
} from "./analyze";
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

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function seed(conn: SqliteConn): void {
  const rows = [
    {
      id: "c1",
      fullName: "Jane Doe",
      company: "Stripe",
      industry: "Fintech",
      role: "Senior Engineer",
      relationshipScore: 0.8,
      lastInteraction: iso(5),
      createdAt: iso(400),
    },
    {
      id: "c2",
      fullName: "John Smith",
      company: "Stripe",
      industry: "Fintech",
      role: "Engineer",
      relationshipScore: 0.4,
      lastInteraction: null,
      createdAt: iso(200), // never interacted, acquired 200d ago → dormant
    },
    {
      id: "c3",
      fullName: "Alice Wong",
      company: "Vercel",
      industry: "Software",
      role: "Designer",
      relationshipScore: 0.2,
      lastInteraction: iso(120),
      createdAt: iso(120),
    },
  ];
  for (const r of rows) {
    conn.db
      .insert(conn.schema.contacts)
      .values({ ...r, source: "test", updatedAt: iso(0) })
      .run();
  }
}

describe("toAnalyzeOptions", () => {
  it("applies defaults", () => {
    expect(toAnalyzeOptions({})).toMatchObject({ dormantDays: 90, limit: 10 });
  });

  it("maps days and limit", () => {
    expect(toAnalyzeOptions({ days: "30", limit: "5" })).toMatchObject({
      dormantDays: 30,
      limit: 5,
    });
  });

  it.each([
    [{ days: "abc" }, /--days/],
    [{ days: "0" }, /--days/],
    [{ limit: "x" }, /--limit/],
  ])("rejects invalid numbers %j", (opts, pattern) => {
    expect(() => toAnalyzeOptions(opts as never)).toThrow(pattern as RegExp);
  });
});

describe("selectedSection", () => {
  it("defaults to the full report", () => {
    expect(selectedSection({})).toBe("full");
  });

  it.each([
    [{ networkScore: true }, "score"],
    [{ dormant: true }, "dormant"],
    [{ clusters: true }, "clusters"],
  ] as const)("maps each section flag %j", (opts, expected) => {
    expect(selectedSection(opts)).toBe(expected);
  });

  it.each([
    [{ networkScore: true, dormant: true }],
    [{ dormant: true, clusters: true }],
    [{ networkScore: true, clusters: true, dormant: true }],
  ])("rejects combinations %j", (opts) => {
    expect(() => selectedSection(opts as never)).toThrow(/mutually exclusive/);
  });
});

describe("executeAnalyze", () => {
  let conn: SqliteConn;
  beforeEach(() => {
    conn = createTestConn();
    seed(conn);
  });

  it("renders the full report with score, metrics, growth, clusters, and dormant ties", async () => {
    const out = await executeAnalyze({}, conn);

    expect(out).toMatch(/Network score: \d+\/100/);
    expect(out).toMatch(/activity\s+\d/);
    expect(out).toMatch(/Contacts: 3 total · 1 active \(30d\) · 2 dormant \(90d\+\)/);
    expect(out).toMatch(/Diversity: [\d.]+ effective industry/);
    expect(out).toMatch(/Growth \(last 30 days\): \+\d+/);
    expect(out).toMatch(/2026-\d{2} │/); // growth chart rows
    expect(out).toMatch(/Top companies:\n\s+stripe {2}2/);
    expect(out).toMatch(/Clusters \(contacts grouped by company\):/);
    expect(out).toMatch(/Stripe — 2 contacts/);
    expect(out).toMatch(/Dormant ties \(no known interaction in 90\+ days/);
    expect(out).toMatch(/John Smith — last touch 200d ago/);
    expect(out).toMatch(/Alice Wong — last touch 120d ago/);
  });

  it("renders an empty state for a fresh database", async () => {
    const empty = createTestConn();
    const out = await executeAnalyze({}, empty);
    expect(out).toMatch(/Network score: 0\/100/);
    expect(out).toMatch(/Contacts: 0 total/);
    expect(out).toMatch(/No company data yet/);
    expect(out).toMatch(/None — every known touchpoint is inside the window/);
  });

  it("--network-score prints just the score card", async () => {
    const out = await executeAnalyze({ networkScore: true }, conn);
    expect(out).toMatch(/^Network score: \d+\/100/);
    expect(out).not.toMatch(/Contacts:/);
    expect(out).not.toMatch(/Dormant/);
  });

  it("--dormant prints only the dormant section", async () => {
    const out = await executeAnalyze({ dormant: true }, conn);
    expect(out).toMatch(/Dormant ties/);
    expect(out).toMatch(/John Smith/);
    expect(out).not.toMatch(/Network score/);
  });

  it("--clusters prints only the clusters section", async () => {
    const out = await executeAnalyze({ clusters: true }, conn);
    expect(out).toMatch(/Clusters \(contacts grouped by company\):/);
    expect(out).toMatch(/Vercel — 1 contact/);
    expect(out).not.toMatch(/Network score/);
    expect(out).not.toMatch(/Dormant ties/);
  });

  it("--days widens the dormancy window and the report labels it", async () => {
    const out = await executeAnalyze({ days: "150" }, conn);
    expect(out).toMatch(/dormant \(150d\+\)/);
    expect(out).toMatch(/no known interaction in 150\+ days/);
    expect(out).toMatch(/John Smith — last touch 200d ago/);
    expect(out).not.toMatch(/Alice Wong — last touch 120d/); // 120d < 150d window
  });

  it("--limit caps list rows", async () => {
    const out = await executeAnalyze({ limit: "1" }, conn);
    const dormantRows = out.match(/last touch \d+d ago/g) ?? [];
    expect(dormantRows).toHaveLength(1);
  });

  it("--json emits the raw overview object", async () => {
    const out = await executeAnalyze({ json: true }, conn);
    const parsed = JSON.parse(out) as {
      metrics: { totalContacts: number };
      score: { score: number };
      dormant: unknown[];
      clusters: unknown[];
      growth: { series: unknown[] };
    };
    expect(parsed.metrics.totalContacts).toBe(3);
    expect(parsed.score.score).toBeGreaterThan(0);
    expect(parsed.dormant).toHaveLength(2);
    expect(parsed.clusters).toHaveLength(2);
    expect(parsed.growth.series).toHaveLength(12);
  });

  it("--json wins over section flags for scripts", async () => {
    const out = await executeAnalyze({ json: true, dormant: true }, conn);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
