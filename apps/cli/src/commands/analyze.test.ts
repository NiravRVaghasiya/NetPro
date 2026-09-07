import { describe, it, expect, beforeEach } from "vitest";
import {
  executeAnalyze,
  selectedSection,
  toAnalyzeOptions,
} from "./analyze";
import type { SqliteConn } from "@netpro/db";
import { createTestSqliteConn } from "@netpro/db/src/testing";

// Migrated fixture: contacts + edges + everything `getNetworkOverview`
// (including the v2.0 graph section) reads, straight from the migrations.
function createTestConn(): SqliteConn {
  return createTestSqliteConn().conn;
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
    [{ graph: true }, "graph"],
  ] as const)("maps each section flag %j", (opts, expected) => {
    expect(selectedSection(opts)).toBe(expected);
  });

  it.each([
    [{ networkScore: true, dormant: true }],
    [{ dormant: true, clusters: true }],
    [{ clusters: true, graph: true }],
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

describe("executeAnalyze --graph", () => {
  it("shows the empty state until edges exist", async () => {
    const conn = createTestConn();
    conn.db
      .insert(conn.schema.contacts)
      .values({ id: "x", fullName: "Solo Sam", source: "test", createdAt: iso(10), updatedAt: iso(10) })
      .run();
    const out = await executeAnalyze({ graph: true }, conn);
    expect(out).toMatch(/Network graph:/);
    expect(out).toMatch(/No confirmed edges yet/);
    expect(out).not.toMatch(/Network score/);
  });

  it("renders communities, centrality, and warm-intro candidates", async () => {
    const conn = createTestConn();
    const people = [
      ["a", "Ada Lovelace"],
      ["b", "Bob Builder"],
      ["c", "Cara Chen"],
      ["d", "Dan Delta"],
    ] as const;
    for (const [id, fullName] of people) {
      conn.db
        .insert(conn.schema.contacts)
        .values({
          id,
          fullName,
          source: "test",
          relationshipScore: id === "b" ? 0.9 : 0.3,
          createdAt: iso(10),
          updatedAt: iso(10),
        })
        .run();
    }
    for (const [s, t] of [["a", "b"], ["b", "c"], ["c", "a"], ["b", "d"]] as const) {
      conn.db
        .insert(conn.schema.edges)
        .values({
          id: `${s}-${t}`,
          sourceId: s,
          targetId: t,
          relation: "manual",
          strength: 0.5,
          bidirectional: true,
          source: "manual",
          confidence: 1,
          status: "confirmed",
          discoveredAt: iso(5),
          updatedAt: iso(5),
        })
        .run();
    }
    const out = await executeAnalyze({ graph: true }, conn);
    expect(out).toMatch(/Network graph \(4 of 4 contacts linked · 4 edges\)/);
    // K3+tail has no positive-Q split: Louvain settles at Q = 0.
    expect(out).toMatch(/Communities: 2 \(modularity 0\)/);
    expect(out).toMatch(/Most connected:/);
    // b sits interior to exactly {a,d} and {c,d}: raw 2, norm 2/3 = 0.67.
    expect(out).toMatch(/Bob Builder — 3 edges · betweenness 0\.67/);
    expect(out).toMatch(/Components: 1 .* · avg path length 1\.33/);
    expect(out).toMatch(/Warm-intro candidates/);
    // Hubs are ranked by degree, so the first suggestion reaches a degree-2
    // contact from the other side of Bob: d→a and d→c before a→d/c→d.
    expect(out).toMatch(/Dan Delta → Ada Lovelace via Bob Builder \(2 hops\)/);
    expect(out).not.toMatch(/pending edge candidate/);
  });

  it("includes the graph strip in the full report too", async () => {
    const conn = createTestConn();
    conn.db
      .insert(conn.schema.contacts)
      .values({ id: "x", fullName: "Solo Sam", source: "test", createdAt: iso(10), updatedAt: iso(10) })
      .run();
    const out = await executeAnalyze({}, conn);
    expect(out).toMatch(/Network graph:/);
    expect(out).toMatch(/Network score/);
  });

  it("--json carries the graph section", async () => {
    const conn = createTestConn();
    const out = await executeAnalyze({ json: true }, conn);
    const parsed = JSON.parse(out) as { graph?: { nodes: number } };
    expect(parsed.graph?.nodes).toBe(0);
  });
});
