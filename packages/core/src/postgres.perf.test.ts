// v2.0 Phase 7 — the real-Postgres performance pass.
// v2.5 Phase 7 — extended with the Observer fixtures: on top of the v2.0
// 5k contacts / 20k edges graph, the same database now carries 10k profile
// views + 1k content items + 5k metric snapshots, so the release gate
// measures what the dashboard actually serves after v2.5 — analytics with
// the views and content blocks included, `getViewsOverview`
// (`GET /api/card/views`) and the content list/overview
// (`GET /api/content`, the "At a glance" payload).
//
// WHY THIS FILE EXISTS. The v2.0 plan asks for one before the cut: "5k
// contacts / 20k edges fixture; record dashboard `GET /api/analytics`,
// `/api/search` hybrid, `/api/graph` latencies", in the same
// measure-and-record discipline that caught the v1 migration race. Every
// v2.0 phase was measured on SQLite or on synthetic in-memory graphs
// (`graph/perf.test.ts`); nothing had ever been timed against a real server
// with a real query planner, real `tsvector` indexes and real round-trips.
// Those are three different costs, and only Postgres has all of them. The
// v2.5 plan repeats the request for its own budgets: "Performance pass
// extended: 5k contacts / 20k edges / 10k views / 1k content — record
// dashboard, views, content latencies." The Phase 6 SQLite budget test
// (`perf.budget.test.ts`) is hermetic; this file is the real-planner
// confirmation of the same numbers.
//
// WHAT IT MEASURES. The core entry points behind the endpoints the plans
// name — `getNetworkOverview` (the dashboard, with and without its graph
// section, now with the views + content blocks included), `getNetworkGraph`
// (`/api/graph/overview`), `searchContacts` in both `keyword` and `hybrid`
// mode, `planIntroPaths` (the pathfinder, which reloads the graph per
// request by design), `getViewsOverview` (the views composition the CLI,
// API and dashboard share) and `listContentSummaries` + `getContentOverview`
// (the content library and its "At a glance" strip).
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// `npm test` stays hermetic, offline and fast. CI's postgres job supplies it.
//
// The budgets asserted here are deliberately loose — this is a smoke alarm,
// not a benchmark. A 20× regression on a loaded CI runner has to fail the
// build; 15 % jitter must not. The interesting output is the recorded
// numbers, not the assertion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@netpro/db/src/schema.pg';
import { runMigrations } from '@netpro/db';
import type { PgConn } from '@netpro/db';
import { getNetworkOverview } from './analytics';
import { getContentOverview, listContentSummaries } from './content/repository';
import { getNetworkGraph, planIntroPaths } from './graph';
import { reindexSearchIndex, searchContacts } from './search';
import { getViewsOverview } from './views/analytics';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const CONTACTS = 5_000;
const EDGES = 20_000;
const VIEWS = 10_000;
const CONTENT_ITEMS = 1_000;
const METRICS = 5_000;

const dbName = `netpro_core_perf_${Date.now().toString(36)}`;
const now = new Date('2026-09-08T12:00:00.000Z');

/** Deterministic LCG — the same fixture on every machine and run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const COMPANIES = ['Stripe', 'Figma', 'Acme', 'Monzo', 'Klarna', 'Shopify', 'Linear', 'Ramp'];
const INDUSTRIES = ['fintech', 'devtools', 'design', 'commerce', 'health', 'logistics'];
const ROLES = ['Engineer', 'Designer', 'Founder', 'Product Manager', 'Data Scientist', 'Recruiter'];
const TOPICS = [
  'kubernetes rollouts',
  'postgres query plans',
  'design systems',
  'growth loops',
  'payments rails',
  'typeScript migrations',
  'on-call rotations',
  'pricing experiments',
];
const QUERIES = ['kubernetes', 'postgres', 'design systems', 'growth', 'engineer', 'fintech'];

const VIEW_COUNTRIES = ['DE', 'PT', 'US', 'GB', 'IN', 'BR', 'JP', null];
const VIEW_REFERRERS = [
  'https://news.ycombinator.com',
  'https://blog.example/',
  'https://www.google.com/',
  'https://x.com/',
  'https://dev.to/',
  null,
];
const CONTENT_PLATFORMS = ['blog', 'devto', 'twitter', 'linkedin', 'github', 'rss'] as const;

/**
 * Expected analytics counts, computed while the fixture is generated with
 * exactly the predicates the core applies (non-bot, non-owner, inside the
 * window), so the perf pass also asserts correctness on the live planner —
 * the views module had no dedicated live-Postgres suite.
 */
const expected = {
  views30d: 0,
  /** Distinct resolved contacts in the 30-day window (the stats metric is COUNT(DISTINCT), not rows). */
  resolved30d: 0,
  contentWithMetrics: 0,
};

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Run `fn` `runs` times and report min/median/max in milliseconds. */
async function time(runs: number, fn: () => Promise<unknown>): Promise<{ min: number; median: number; max: number }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    min: samples[0]!,
    median: samples[Math.floor(samples.length / 2)]!,
    max: samples[samples.length - 1]!,
  };
}

const ms = (n: number): string => `${n.toFixed(0)}ms`;

describeIfPg('v2.0 performance pass against live PostgreSQL', () => {
  let conn: PgConn;

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(`CREATE DATABASE "${dbName}"`);
    });
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    conn = { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
    await runMigrations(conn, { force: true });

    const seeded = await time(1, async () => {
      const rand = rng(42);
      const rows = Array.from({ length: CONTACTS }, (_, i) => {
        const id = `c${String(i).padStart(5, '0')}`;
        const topic = TOPICS[Math.floor(rand() * TOPICS.length)]!;
        const daysAgo = Math.floor(rand() * 400);
        const touched = rand() < 0.7;
        const created = new Date(now.getTime() - (daysAgo + 30) * 86_400_000).toISOString();
        return {
          id,
          fullName: `Contact ${String(i).padStart(5, '0')}`,
          email: `person${i}@example.com`,
          headline: `${ROLES[Math.floor(rand() * ROLES.length)]!} at ${
            COMPANIES[Math.floor(rand() * COMPANIES.length)]!
          }`,
          company: COMPANIES[Math.floor(rand() * COMPANIES.length)]!,
          industry: INDUSTRIES[Math.floor(rand() * INDUSTRIES.length)]!,
          role: ROLES[Math.floor(rand() * ROLES.length)]!,
          location: rand() < 0.5 ? 'Berlin' : 'Lisbon',
          notes: `Works on ${topic}. Met at a conference; follow up about ${topic}.`,
          source: 'perf',
          relationshipScore: Math.round(rand() * 100) / 100,
          lastInteraction: touched ? new Date(now.getTime() - daysAgo * 86_400_000).toISOString() : null,
          interactionCount: touched ? 1 + Math.floor(rand() * 9) : 0,
          createdAt: created,
          updatedAt: created,
        };
      });
      // Chunked so a single statement stays well inside Postgres' 65535
      // parameter ceiling (and inside the packet size while we are at it).
      for (let i = 0; i < rows.length; i += 500) {
        await conn.db.insert(schema.contacts).values(rows.slice(i, i + 500));
      }

      // Clustered structure — most edges stay inside a block of 10 ids so
      // Louvain has real communities to find instead of one giant blob.
      const seen = new Set<string>();
      const edges: Array<{
        id: string;
        sourceId: string;
        targetId: string;
        relation: string;
        strength: number;
        confidence: number;
        bidirectional: boolean;
        source: string;
        status: string;
        discoveredAt: string;
        updatedAt: string;
      }> = [];
      while (edges.length < EDGES) {
        const i = Math.floor(rand() * CONTACTS);
        const j = (i + 1 + Math.floor(rand() * (rand() < 0.85 ? 10 : CONTACTS - 1))) % CONTACTS;
        if (i === j) continue;
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const lo = String(Math.min(i, j)).padStart(5, '0');
        const hi = String(Math.max(i, j)).padStart(5, '0');
        edges.push({
          id: `e${edges.length}`,
          sourceId: `c${lo}`,
          targetId: `c${hi}`,
          relation: 'manual',
          strength: 0.5,
          confidence: 1,
          bidirectional: true,
          source: 'manual',
          status: 'confirmed',
          discoveredAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
      for (let i = 0; i < edges.length; i += 1_000) {
        await conn.db.insert(schema.edges).values(edges.slice(i, i + 1_000));
      }

      // ── v2.5 Observer fixture ─────────────────────────────────────────
      // 10k profile views over ~95 days (the last 5 days fall outside the
      // 90-day retention window; a slice lands outside the 30-day analytics
      // default), 5% bots, 2% owner views, 10% DNT-minimal rows without a
      // fingerprint, 30% resolved to a real contact from the first 100.
      const since30 = now.getTime() - 30 * 86_400_000;
      const resolvedInWindow = new Set<string>();
      const views: Array<typeof schema.profileViews.$inferInsert> = [];
      for (let i = 0; i < VIEWS; i++) {
        const isBot = rand() < 0.05;
        const isOwnerView = !isBot && rand() < 0.02;
        const dntMinimal = rand() < 0.1;
        const daysAgo = rand() * 95;
        const viewedAt = new Date(now.getTime() - daysAgo * 86_400_000);
        const resolved =
          !isBot && !isOwnerView && rand() < 0.3
            ? `c${String(Math.floor(rand() * 100)).padStart(5, '0')}`
            : null;
        const inWindow = viewedAt.getTime() >= since30 && viewedAt.getTime() <= now.getTime();
        if (inWindow && !isBot && !isOwnerView) {
          expected.views30d += 1;
          if (resolved !== null) resolvedInWindow.add(resolved);
        }
        views.push({
          id: `v${String(i).padStart(6, '0')}`,
          viewerIp: Array.from({ length: 16 }, () => Math.floor(rand() * 16).toString(16)).join(''),
          viewerAgent: dntMinimal ? null : 'Mozilla/5.0 (perf fixture)',
          viewerFingerprint: dntMinimal ? null : `fp${String(i).padStart(14, '0')}`,
          referrer: VIEW_REFERRERS[Math.floor(rand() * VIEW_REFERRERS.length)]!,
          resolvedContact: resolved,
          isBot,
          isOwnerView,
          sessionId: dntMinimal ? `s${String(i).padStart(10, '0')}` : null,
          durationMs: rand() < 0.8 ? Math.floor(rand() * 240_000) : null,
          viewedPage: '/card',
          viewedAt: viewedAt.toISOString(),
          country: VIEW_COUNTRIES[Math.floor(rand() * VIEW_COUNTRIES.length)]!,
        });
      }
      expected.resolved30d = resolvedInWindow.size;
      for (let i = 0; i < views.length; i += 1_000) {
        await conn.db.insert(schema.profileViews).values(views.slice(i, i + 1_000));
      }

      // 1k content items across the platform whitelist; every fifth item
      // (i % 5 === 4) deliberately has no snapshots — "unreported is not
      // zero" is a fact the overview has to survive.
      const items: Array<typeof schema.contentItems.$inferInsert> = [];
      for (let i = 0; i < CONTENT_ITEMS; i++) {
        const published = rand() < 0.7;
        const platform = CONTENT_PLATFORMS[i % CONTENT_PLATFORMS.length]!;
        items.push({
          id: `ct${String(i).padStart(4, '0')}`,
          url: `https://example.com/post-${i}?utm_source=perf`,
          urlNorm: `https://example.com/post-${i}`,
          title: `Post ${String(i).padStart(4, '0')} on ${platform}`,
          platform,
          publishedAt: published
            ? new Date(now.getTime() - rand() * 400 * 86_400_000).toISOString()
            : null,
          author: rand() < 0.5 ? 'Owner' : null,
          tags: JSON.stringify([platform, 'perf']),
          source: i % 3 === 0 ? 'rss' : 'manual',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
      for (let i = 0; i < items.length; i += 500) {
        await conn.db.insert(schema.contentItems).values(items.slice(i, i + 500));
      }

      // 5k snapshots spread over the last ~360 days. Every non-reserved item
      // (i % 5 !== 4) first gets one snapshot, then the remainder are spread
      // randomly — so `withMetrics` is exact, not probabilistic.
      const eligible = (i: number): boolean => i % 5 !== 4;
      const newMetric = (n: number, item: number, maxDaysAgo: number) => ({
        id: `m${String(n).padStart(7, '0')}`,
        contentId: `ct${String(item).padStart(4, '0')}`,
        fetchedAt: new Date(now.getTime() - rand() * maxDaysAgo * 86_400_000).toISOString(),
        source: 'manual',
        views: Math.floor(rand() * 5_000),
        likes: rand() < 0.9 ? Math.floor(rand() * 500) : null,
        comments: rand() < 0.8 ? Math.floor(rand() * 100) : null,
        shares: null,
        bookmarks: null,
        createdAt: now.toISOString(),
      });
      const metrics: Array<ReturnType<typeof newMetric>> = [];
      for (let i = 0; i < CONTENT_ITEMS; i++) {
        if (eligible(i)) metrics.push(newMetric(metrics.length, i, 360));
      }
      while (metrics.length < METRICS) {
        const item = Math.floor(rand() * CONTENT_ITEMS);
        if (!eligible(item)) continue;
        metrics.push(newMetric(metrics.length, item, 360));
      }
      expected.contentWithMetrics = new Set(metrics.map((m) => m.contentId)).size;
      for (let i = 0; i < metrics.length; i += 500) {
        await conn.db.insert(schema.contentMetrics).values(metrics.slice(i, i + 500));
      }
    });

    const indexed = await time(1, () => reindexSearchIndex(conn));
    console.info(
      `[perf] fixture: ${CONTACTS} contacts / ${EDGES} edges / ${VIEWS} views / ` +
        `${CONTENT_ITEMS} content items / ${METRICS} metrics seeded in ${ms(seeded.median)}; ` +
        `keyword index built in ${ms(indexed.median)}`
    );
  }, 600_000);

  afterAll(async () => {
    await conn?.pool.end();
    await withAdmin(async (client) => {
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName]);
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }).catch(() => {
      // Best effort cleanup of a throwaway database.
    });
  }, 120_000);

  it('the dashboard overview stays inside its budget on 5k contacts / 20k edges', async () => {
    const withGraph = await time(3, () => getNetworkOverview(conn, { includeGraph: true, now }));
    const without = await time(3, () =>
      getNetworkOverview(conn, {
        includeGraph: false,
        includeViews: false,
        includeContent: false,
        now,
      })
    );
    console.info(
      `[perf] GET /api/analytics (5k/20k + 10k views + 1k content): full ${ms(withGraph.median)} ` +
        `(min ${ms(withGraph.min)}), everything-but-graph/views/content ${ms(without.median)} ` +
        `(min ${ms(without.min)}) — the full payload includes the v2.5 views and content blocks`
    );

    const overview = await getNetworkOverview(conn, { includeGraph: false, now });
    expect(overview.metrics.totalContacts).toBe(CONTACTS);
    // v2.5: the shared dashboard payload carries the Observer blocks on the
    // same call — correctness of the composition, not just its speed.
    expect(overview.views?.stats.totals.views).toBe(expected.views30d);
    expect(overview.views?.stats.totals.resolvedContacts).toBe(expected.resolved30d);
    expect(overview.content?.items).toBe(CONTENT_ITEMS);
    expect(overview.content?.withMetrics).toBe(expected.contentWithMetrics);

    expect(withGraph.median).toBeLessThan(20_000);
    expect(without.median).toBeLessThan(10_000);
  }, 300_000);

  it('the views overview stays inside its budget on 10k views', async () => {
    // `now` pins the 30-day window to the fixture clock, so the totals are
    // exact rather than drifting with wall-clock time between seed and test.
    const stats = await time(3, () => getViewsOverview(conn, { days: 30, limit: 10, now }));
    console.info(
      `[perf] GET /api/card/views (10k views, 30d window): ${ms(stats.median)} (min ${ms(stats.min)})`
    );

    const overview = await getViewsOverview(conn, { days: 30, limit: 10, now });
    expect(overview.stats.totals.views).toBe(expected.views30d);
    expect(overview.stats.totals.resolvedContacts).toBe(expected.resolved30d);
    expect(overview.stats.excluded.bots).toBeGreaterThan(0);
    expect(overview.stats.series).toHaveLength(30);
    expect(stats.median).toBeLessThan(5_000);
  }, 300_000);

  it('the content list and overview stay inside their budget on 1k items / 5k metrics', async () => {
    const list = await time(3, () => listContentSummaries(conn, { limit: 50 }));
    const glance = await time(3, () => getContentOverview(conn, { now }));
    console.info(
      `[perf] GET /api/content (1k items / 5k metrics): list(50) ${ms(list.median)} ` +
        `(min ${ms(list.min)}), overview ${ms(glance.median)} (min ${ms(glance.min)})`
    );

    const summaries = await listContentSummaries(conn, { limit: 50 });
    expect(summaries.total).toBe(CONTENT_ITEMS);
    expect(summaries.items).toHaveLength(50);
    // The list is newest-published-first, so pick the probe rows by title
    // query instead of assuming where they landed: ct0000 has snapshots,
    // ct0004 (every fifth item) deliberately does not.
    const withSnapshots = (
      await listContentSummaries(conn, { query: 'Post 0000 ', limit: 50 })
    ).items.find((i) => i.metricsCount > 0);
    expect(withSnapshots).toBeDefined();
    const withoutSnapshots = (
      await listContentSummaries(conn, { query: 'Post 0004 ', limit: 50 })
    ).items[0];
    expect(withoutSnapshots?.metricsCount ?? -1).toBe(0);

    const overview = await getContentOverview(conn, { now });
    expect(overview.items).toBe(CONTENT_ITEMS);
    expect(overview.withMetrics).toBe(expected.contentWithMetrics);
    expect(overview.totalViews).toBeGreaterThan(0);
    expect(list.median).toBeLessThan(5_000);
    expect(glance.median).toBeLessThan(5_000);
  }, 300_000);

  it('the graph overview endpoint stays inside its budget', async () => {
    const stats = await time(3, () => getNetworkGraph(conn));
    console.info(`[perf] GET /api/graph/overview (5k/20k): ${ms(stats.median)} (min ${ms(stats.min)})`);

    const graph = await getNetworkGraph(conn);
    expect(graph.edges).toBe(EDGES);
    expect(stats.median).toBeLessThan(20_000);
  }, 300_000);

  it('hybrid and keyword search stay inside their budgets', async () => {
    const keyword = await time(QUERIES.length, () =>
      searchContacts(conn, { query: QUERIES[0]!, mode: 'keyword', limit: 20 })
    );
    const hybrid = await time(QUERIES.length, () =>
      searchContacts(conn, { query: QUERIES[0]!, mode: 'hybrid', limit: 20 })
    );
    console.info(
      `[perf] GET /api/search (5k contacts, ${QUERIES.length} calls each): ` +
        `keyword ${ms(keyword.median)} (min ${ms(keyword.min)}), ` +
        `hybrid ${ms(hybrid.median)} (min ${ms(hybrid.min)}) — hybrid here has no ` +
        `configured embedder, so the vector arm is absent and the number is the ` +
        `keyword arm plus the RRF merge (the vector call is the operator's bill, ` +
        `not this repo's)`
    );

    // `engine` reports what was actually served, not what was asked for: with
    // no embedder configured here the vector arm never runs, so a `hybrid`
    // request is honestly reported as `keyword`. That is the degradation the
    // docs promise, measured end to end rather than asserted in a unit test.
    const hits = await searchContacts(conn, { query: 'kubernetes', mode: 'hybrid', limit: 20 });
    expect(hits.contacts.length).toBeGreaterThan(0);
    expect(hits.engine.requested).toBe('hybrid');
    expect(hits.engine.mode).toBe('keyword');
    expect(hits.engine.arms.semantic.used).toBe(false);
    expect(keyword.median).toBeLessThan(2_000);
    expect(hybrid.median).toBeLessThan(3_000);
  }, 300_000);

  it('the pathfinder stays inside its budget', async () => {
    // Ten plans, each of which reloads the graph — that is the real per-request
    // cost of `/api/graph/paths`, not the BFS itself.
    const plans = await time(10, () => planIntroPaths(conn, { target: 'c04500', k: 3 }));
    console.info(`[perf] GET /api/graph/paths (10 plans, 5k/20k): ${ms(plans.median)} (min ${ms(plans.min)})`);
    expect(plans.median).toBeLessThan(5_000);
  }, 300_000);
});
