import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import type { SqliteConn } from "@netpro/db";
import {
  computeNetworkMetrics,
  computeNetworkScore,
  countValues,
  effectiveCategories,
  projectContacts,
  shannonEntropy,
} from "./metrics";
import { getGrowthSummary } from "./growth";
import { detectClusters } from "./clusters";
import { getDormantContacts } from "./dormant";
import { getNetworkOverview } from "./overview";
import type { AnalyticsOptions } from "./types";

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
  fullName?: string;
  company?: string | null;
  industry?: string | null;
  role?: string | null;
  relationshipScore?: number | null;
  lastInteraction?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

const NOW = new Date("2026-09-06T12:00:00.000Z");
const OPTS: AnalyticsOptions = { now: NOW };

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function seed(conn: SqliteConn, rows: Seed[]): Promise<void> {
  for (const r of rows) {
    await conn.db.insert(conn.schema.contacts).values({
      id: r.id,
      fullName: r.fullName ?? r.id,
      company: r.company ?? null,
      industry: r.industry ?? null,
      role: r.role ?? null,
      relationshipScore: r.relationshipScore ?? 0,
      lastInteraction: r.lastInteraction ?? null,
      createdAt: r.createdAt ?? iso(0),
      updatedAt: iso(0),
      deletedAt: r.deletedAt ?? null,
      source: "test",
    });
  }
}

describe("analytics / projection", () => {
  it("excludes soft-deleted contacts", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a" },
      { id: "b", deletedAt: iso(1) },
    ]);
    const rows = await projectContacts(conn);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("analytics / metrics", () => {
  it("counts active, dormant, and totals across windows", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "active", lastInteraction: iso(5), createdAt: iso(100) },
      { id: "stale", lastInteraction: iso(120), createdAt: iso(200) },
      { id: "never", lastInteraction: null, createdAt: iso(200) },
      { id: "fresh", lastInteraction: null, createdAt: iso(3) },
      { id: "gone", deletedAt: iso(1) },
    ]);
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.totalContacts).toBe(4);
    expect(m.activeConnections).toBe(1); // only `active`
    expect(m.dormantConnections).toBe(2); // `stale` + `never` (fallback to createdAt)
    expect(m.activeRate).toBeCloseTo(0.25);
    expect(m.dormantRate).toBeCloseTo(0.5);
    expect(m.avgRelationshipScore).toBe(0);
  });

  it("never-interacted contacts become dormant via their connection date", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "old", createdAt: iso(400) },
      { id: "new", createdAt: iso(2) },
    ]);
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.dormantConnections).toBe(1);
    expect(m.totalContacts).toBe(2);
  });

  it("respects a custom dormancy window", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", lastInteraction: iso(45) },
      { id: "b", lastInteraction: iso(10) },
    ]);
    expect((await computeNetworkMetrics(conn, { ...OPTS, dormantDays: 30 })).dormantConnections).toBe(1);
    expect((await computeNetworkMetrics(conn, { ...OPTS, dormantDays: 60 })).dormantConnections).toBe(0);
  });

  it("averages non-null relationship scores only", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", relationshipScore: 0.8 },
      { id: "b", relationshipScore: 0.4 },
    ]);
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.avgRelationshipScore).toBeCloseTo(0.6);
  });

  it("falls back to company diversity when industry is not populated", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", company: "Stripe", industry: null },
      { id: "b", company: "Stripe", industry: null },
      { id: "c", company: "Vercel", industry: null },
      { id: "d", company: "Google", industry: null },
      { id: "e", company: "Google", industry: null },
    ]);
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.diversityField).toBe("company");
    // 5 contacts over 3 companies: entropy ≈ 1.0549 nats → ≈ 2.87 effective.
    expect(m.diversityEffective).toBeGreaterThan(2.8);
    expect(m.diversityEffective).toBeLessThan(2.9);
    expect(m.companiesDistinct).toBe(3);
    expect(m.industriesDistinct).toBe(0);
  });

  it("prefers industry diversity when at least two industries exist", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", company: "Stripe", industry: "Fintech" },
      { id: "b", company: "Vercel", industry: "Software" },
      { id: "c", company: "Google", industry: "Software" },
    ]);
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.diversityField).toBe("industry");
    expect(m.industriesDistinct).toBe(2);
    // 3 contacts over 2 industries → between 1 and 2 effective categories.
    expect(m.diversityEffective).toBeGreaterThan(1);
    expect(m.diversityEffective).toBeLessThan(2);
  });

  it("is empty-safe", async () => {
    const conn = createTestConn();
    const m = await computeNetworkMetrics(conn, OPTS);
    expect(m.totalContacts).toBe(0);
    expect(m.activeRate).toBe(0);
    expect(m.avgRelationshipScore).toBeNull();
    expect(m.diversityEffective).toBe(0);
  });
});

describe("analytics / entropy", () => {
  it("is zero for a single category and ln(n) for uniform spread", () => {
    expect(shannonEntropy([5])).toBe(0);
    expect(shannonEntropy([])).toBe(0);
    expect(shannonEntropy([1, 1, 1, 1])).toBeCloseTo(Math.log(4));
    expect(effectiveCategories([2, 2])).toBeCloseTo(2);
    expect(effectiveCategories([4])).toBeCloseTo(1);
  });

  it("counts values deterministically", () => {
    const counts = countValues(["b", "a", "b"]);
    expect(counts).toEqual([
      { value: "b", count: 2 },
      { value: "a", count: 1 },
    ]);
  });
});

describe("analytics / score", () => {
  it("returns 0 for an empty network", () => {
    const s = computeNetworkScore({
      totalContacts: 0,
      activeRate: 0,
      diversityEffective: 0,
      newLast30Days: 0,
    });
    expect(s.score).toBe(0);
  });

  it("caps at 100 and weights the four factors", () => {
    const perfect = computeNetworkScore({
      totalContacts: 500,
      activeRate: 1,
      diversityEffective: 8,
      newLast30Days: 20,
    });
    expect(perfect.score).toBe(100);
    expect(perfect.factors.map((f) => f.key)).toEqual([
      "activity",
      "diversity",
      "size",
      "growth",
    ]);
    expect(perfect.factors.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(1);
  });

  it("scales proportionally between the extremes", () => {
    const s = computeNetworkScore({
      totalContacts: 250, // size 50
      activeRate: 0.5, // activity 50
      diversityEffective: 4, // diversity 50
      newLast30Days: 10, // growth 50
    });
    expect(s.score).toBe(50);
  });
});

describe("analytics / growth", () => {
  it("buckets by UTC month with a cumulative baseline from before the window", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "ancient", createdAt: "2024-01-15T10:00:00.000Z" },
      { id: "may", createdAt: "2026-05-10T10:00:00.000Z" },
      { id: "may2", createdAt: "2026-05-20T10:00:00.000Z" },
      { id: "june", createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "sept", createdAt: "2026-09-02T10:00:00.000Z" }, // current partial month
    ]);
    const g = await getGrowthSummary(conn, { ...OPTS, growthMonths: 5 });
    expect(g.series.map((p) => p.month)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(g.series.map((p) => p.count)).toEqual([2, 1, 0, 0, 1]);
    expect(g.series.map((p) => p.cumulative)).toEqual([3, 4, 4, 4, 5]); // +1 ancient
  });

  it("computes 30-day growth and the period-over-period rate", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "this-month", createdAt: iso(10) },
      { id: "this-month-2", createdAt: iso(20) },
      { id: "last-month", createdAt: iso(45) },
    ]);
    const g = await getGrowthSummary(conn, OPTS);
    expect(g.last30).toBe(2);
    expect(g.prior30).toBe(1);
    expect(g.ratePct).toBe(100);
  });

  it("reports a null rate when the prior window is empty", async () => {
    const conn = createTestConn();
    await seed(conn, [{ id: "only-new", createdAt: iso(2) }]);
    const g = await getGrowthSummary(conn, OPTS);
    expect(g.prior30).toBe(0);
    expect(g.ratePct).toBeNull();
  });
});

describe("analytics / clusters", () => {
  it("normalizes company casing/whitespace into one cluster with the dominant label", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", company: "Stripe", role: "Engineer" },
      { id: "b", company: "stripe", role: "Engineer" },
      { id: "c", company: "  Stripe  ", role: "Designer" },
      { id: "solo", company: "Vercel", role: "PM" },
      { id: "none", company: null },
      { id: "blank", company: "   " },
    ]);
    const clusters = await detectClusters(conn, OPTS);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.key).toBe("stripe");
    expect(clusters[0]!.label).toBe("Stripe");
    expect(clusters[0]!.size).toBe(3);
    expect(clusters[0]!.share).toBeCloseTo(0.5);
    expect(clusters[0]!.topRoles).toEqual([
      { value: "engineer", count: 2, share: expect.closeTo(2 / 3) },
      { value: "designer", count: 1, share: expect.closeTo(1 / 3) },
    ]);
    expect(clusters[1]!).toMatchObject({ key: "vercel", size: 1 });
  });

  it("orders clusters by size desc and respects the limit", async () => {
    const conn = createTestConn();
    await seed(conn, [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, company: "Small" })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, company: "Mid" })),
      { id: "x", company: "Tiny" },
    ]);
    const clusters = await detectClusters(conn, { ...OPTS, limit: 2 });
    expect(clusters.map((c) => c.label)).toEqual(["Small", "Mid"]);
  });
});

describe("analytics / dormant", () => {
  it("lists dormant ties, ranked by score then longest-ago, with daysSince", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "hi-score", company: "Stripe", role: "Eng", relationshipScore: 0.9, lastInteraction: iso(100) },
      { id: "lo-score", company: "Vercel", relationshipScore: 0.1, lastInteraction: iso(100) },
      { id: "older", company: "Google", relationshipScore: 0.5, lastInteraction: iso(200) },
      { id: "recent", relationshipScore: 0.9, lastInteraction: iso(5) },
      { id: "never-recent", relationshipScore: 0.9, createdAt: iso(2) },
    ]);
    const dormant = await getDormantContacts(conn, OPTS);
    expect(dormant.map((d) => d.id)).toEqual(["older", "hi-score", "lo-score"]);
    expect(dormant[0]!.daysSince).toBe(200);
    expect(dormant[1]!.daysSince).toBe(100);
    expect(dormant[0]!.lastInteraction).toBe(iso(200));
  });

  it("uses the connection date for never-interacted contacts and reports null lastInteraction", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "old-never", fullName: "Old Never", createdAt: iso(150) },
      { id: "fresh-never", createdAt: iso(1) },
    ]);
    const dormant = await getDormantContacts(conn, OPTS);
    expect(dormant).toHaveLength(1);
    expect(dormant[0]!.id).toBe("old-never");
    expect(dormant[0]!.lastInteraction).toBeNull();
    expect(dormant[0]!.daysSince).toBe(150);
  });
});

describe("analytics / overview", () => {
  it("aggregates every section into one payload", async () => {
    const conn = createTestConn();
    await seed(conn, [
      { id: "a", company: "Stripe", industry: "Fintech", role: "Engineer", relationshipScore: 0.9, lastInteraction: iso(3), createdAt: iso(3) },
      { id: "b", company: "stripe", industry: "Fintech", role: "Engineer", createdAt: iso(40) },
      { id: "c", company: "Vercel", industry: "Software", role: "PM", createdAt: iso(120) },
    ]);
    const o = await getNetworkOverview(conn, OPTS);

    expect(o.metrics.totalContacts).toBe(3);
    expect(o.metrics.activeConnections).toBe(1);
    expect(o.metrics.dormantConnections).toBe(1); // only `c` (120d); `b` is 40d, inside the 90d window
    expect(o.score.score).toBeGreaterThan(0);
    expect(o.score.score).toBeLessThanOrEqual(100);
    expect(o.growth.series).toHaveLength(12);
    expect(o.growth.last30).toBe(1);
    expect(o.topCompanies).toEqual([
      { value: "stripe", count: 2, share: expect.closeTo(2 / 3) },
      { value: "vercel", count: 1, share: expect.closeTo(1 / 3) },
    ]);
    expect(o.topIndustries[0]!).toMatchObject({ value: "fintech", count: 2 });
    expect(o.clusters[0]!).toMatchObject({ key: "stripe", size: 2 });
    expect(o.dormant.map((d) => d.id)).toEqual(["c"]);
    expect(o.generatedAt).toBe(NOW.toISOString());
  });
});
