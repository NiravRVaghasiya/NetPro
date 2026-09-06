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
  const now = new Date();
  const rows = [
    {
      id: "c1",
      fullName: "Jane Doe",
      email: "jane@stripe.com",
      company: "Stripe",
      role: "Senior Engineer",
      industry: "Fintech",
      relationshipScore: 0.8,
      lastInteraction: new Date(now.getTime() - 5 * 86400000).toISOString(),
      createdAt: new Date(now.getTime() - 400 * 86400000).toISOString(),
    },
    {
      id: "c2",
      fullName: "John Smith",
      email: "john@vercel.com",
      company: "Stripe",
      role: "Engineer",
      industry: "Fintech",
      relationshipScore: 0.4,
      lastInteraction: null,
      createdAt: new Date(now.getTime() - 200 * 86400000).toISOString(),
    },
    {
      id: "c3",
      fullName: "Alice Wong",
      email: null,
      company: "Vercel",
      role: "Designer",
      industry: "Software",
      relationshipScore: 0.2,
      lastInteraction: new Date(now.getTime() - 120 * 86400000).toISOString(),
      createdAt: new Date(now.getTime() - 120 * 86400000).toISOString(),
    },
  ];
  for (const r of rows) {
    sqlite
      .prepare(
        `INSERT INTO contacts (id, full_name, email, company, role, industry, relationship_score, last_interaction, created_at, updated_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
      )
      .run(
        r.id,
        r.fullName,
        r.email,
        r.company,
        r.role,
        r.industry,
        r.relationshipScore,
        r.lastInteraction,
        r.createdAt,
        now.toISOString(),
      );
  }
  return { conn: { dialect: "sqlite", db, schema } };
});

import { GET } from "./route";

function get(url: string): Promise<Response> {
  return GET(new Request(`http://localhost${url}`));
}

describe("GET /api/analytics", () => {
  it("returns the full overview", async () => {
    const res = await get("/api/analytics");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      metrics: { totalContacts: number; dormantConnections: number };
      score: { score: number };
      growth: { series: unknown[]; last30: number };
      topCompanies: Array<{ value: string; count: number }>;
      clusters: Array<{ key: string; size: number }>;
      dormant: Array<{ id: string }>;
      generatedAt: string;
    };

    expect(body.metrics.totalContacts).toBe(3);
    expect(body.metrics.dormantConnections).toBe(2);
    expect(body.score.score).toBeGreaterThan(0);
    expect(body.growth.series).toHaveLength(12);
    expect(body.topCompanies[0]).toMatchObject({ value: "stripe", count: 2 });
    expect(body.clusters[0]).toMatchObject({ key: "stripe", size: 2 });
    expect(body.dormant).toHaveLength(2);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("accepts the dormancy window via ?days=", async () => {
    const res = await get("/api/analytics?days=150");
    const body = (await res.json()) as {
      metrics: { dormantConnections: number };
      dormant: unknown[];
    };
    // At 150d, Alice (120d) falls inside the window; only John (200d) is dormant.
    expect(body.metrics.dormantConnections).toBe(1);
    expect(body.dormant).toHaveLength(1);
  });

  it("caps list sizes via ?limit=", async () => {
    const res = await get("/api/analytics?limit=1");
    const body = (await res.json()) as {
      dormant: unknown[];
      clusters: unknown[];
    };
    expect(body.dormant).toHaveLength(1);
    expect(body.clusters).toHaveLength(1);
  });

  it("ignores non-numeric params rather than crashing", async () => {
    const res = await get("/api/analytics?days=banana&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: { dormantConnections: number };
      dormant: unknown[];
    };
    expect(body.metrics.dormantConnections).toBe(2);
    expect(body.dormant).toHaveLength(2);
  });
});
