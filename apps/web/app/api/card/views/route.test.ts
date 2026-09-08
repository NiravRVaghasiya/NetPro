import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET } from "./route";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const iso = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function seed(): void {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: "ada",
      fullName: "Ada Lovelace",
      company: "Analytical Engines",
      source: "test",
      createdAt: iso(100),
      updatedAt: iso(100),
    })
    .run();
  const rows = [
    { id: "w1", at: iso(0), referrer: "https://blog.example/hello", country: "GB", contact: "ada" },
    { id: "w2", at: iso(1), referrer: null, country: null, contact: null },
    { id: "w3", at: iso(40), referrer: null, country: null, contact: null },
    { id: "w4", at: iso(0), referrer: null, country: null, contact: null, bot: true },
  ];
  for (const [i, r] of rows.entries()) {
    fixture.conn.db
      .insert(fixture.conn.schema.profileViews)
      .values({
        id: r.id,
        viewerIp: `2${i}23456789abcdef`,
        viewerFingerprint: `d2${i}23456789abcde`,
        isBot: r.bot ?? false,
        isOwnerView: false,
        sessionId: `sess-${r.id}`,
        viewedPage: "/card",
        viewedAt: r.at,
        referrer: r.referrer,
        country: r.country,
        resolvedContact: r.contact,
      })
      .run();
  }
}

beforeEach(() => {
  fixture.sqlite.exec("DELETE FROM profile_views; DELETE FROM contacts;");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
  fixture.sqlite.close();
});

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/card/views${query}`));
}

describe("GET /api/card/views (v2.5 phase 3)", () => {
  it("returns stats, the recent timeline, and known-visitor matches", async () => {
    seed();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      stats: {
        window: { days: number };
        totals: { views: number; uniqueViewers: number };
        excluded: { bots: number; ownerViews: number };
        byReferrer: Array<{ value: string; count: number }>;
      };
      recent: { total: number; views: Array<{ id: string; resolvedContact: unknown }> };
      matches: { total: number; matches: Array<{ contact: { fullName: string } }> };
    };
    expect(body.stats.window.days).toBe(30);
    expect(body.stats.totals).toMatchObject({ views: 2, uniqueViewers: 2 });
    expect(body.stats.excluded).toEqual({ bots: 1, ownerViews: 0 });
    expect(body.stats.byReferrer).toContainEqual({ value: "blog.example", count: 1, share: 0.5 });
    expect(body.recent.total).toBe(2);
    expect(body.matches.total).toBe(1);
    expect(body.matches.matches[0]?.contact.fullName).toBe("Ada Lovelace");
  });

  it("widens the window with ?days= and pages the timeline with ?limit=&offset=", async () => {
    seed();
    const wide = (await (await get("?days=90")).json()) as {
      stats: { totals: { views: number } };
    };
    expect(wide.stats.totals.views).toBe(3);
    const page = (await (await get("?limit=1&offset=1")).json()) as {
      recent: { total: number; limit: number; offset: number; views: Array<{ id: string }> };
    };
    expect(page.recent.total).toBe(2);
    expect(page.recent.limit).toBe(1);
    expect(page.recent.offset).toBe(1);
    expect(page.recent.views).toHaveLength(1);
  });

  it("opts bots back in with ?includeBots=1", async () => {
    seed();
    const body = (await (await get("?includeBots=1")).json()) as {
      stats: { totals: { views: number }; excluded: { bots: number } };
    };
    expect(body.stats.totals.views).toBe(3);
    expect(body.stats.excluded.bots).toBe(0);
  });

  it("clamps out-of-range params and falls back on garbage, echoing the window", async () => {
    seed();
    const clamped = (await (await get("?days=365&limit=500")).json()) as {
      stats: { window: { days: number }; byReferrer: unknown[] };
      recent: { limit: number };
    };
    expect(clamped.stats.window.days).toBe(90);
    expect(clamped.recent.limit).toBe(50);
    const garbage = (await (await get("?days=soon&limit=many")).json()) as {
      stats: { window: { days: number } };
      recent: { limit: number };
    };
    expect(garbage.stats.window.days).toBe(30);
    expect(garbage.recent.limit).toBe(10);
  });

  it("returns zeroes, not an error, for an empty database", async () => {
    const body = (await (await get()).json()) as {
      stats: { totals: { views: number }; series: unknown[] };
      recent: { total: number; views: unknown[] };
      matches: { total: number; matches: unknown[] };
    };
    expect(body.stats.totals.views).toBe(0);
    expect(body.stats.series).toHaveLength(30);
    expect(body.recent).toEqual({ total: 0, limit: 10, offset: 0, views: [] });
    expect(body.matches).toEqual({ matches: [], total: 0 });
  });
});
