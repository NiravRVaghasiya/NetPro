// v2.0 Phase 7 — the real-Postgres performance pass.
//
// WHY THIS FILE EXISTS. The v2.0 plan asks for one before the cut: "5k
// contacts / 20k edges fixture; record dashboard `GET /api/analytics`,
// `/api/search` hybrid, `/api/graph` latencies", in the same
// measure-and-record discipline that caught the v1 migration race. Every
// v2.0 phase was measured on SQLite or on synthetic in-memory graphs
// (`graph/perf.test.ts`); nothing had ever been timed against a real server
// with a real query planner, real `tsvector` indexes and real round-trips.
// Those are three different costs, and only Postgres has all of them.
//
// WHAT IT MEASURES. The core entry points behind the three endpoints the
// plan names — `getNetworkOverview` (the dashboard, with and without its
// graph section), `getNetworkGraph` (`/api/graph/overview`), `searchContacts`
// in both `keyword` and `hybrid` mode, and `planIntroPaths` (the pathfinder,
// which reloads the graph per request by design).
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
import { getNetworkGraph, planIntroPaths } from './graph';
import { reindexSearchIndex, searchContacts } from './search';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const CONTACTS = 5_000;
const EDGES = 20_000;

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

const COMPANIES = ['Stripe', 'Figma', 'Vercel', 'Monzo', 'Klarna', 'Shopify', 'Linear', 'Ramp'];
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
    });

    const indexed = await time(1, () => reindexSearchIndex(conn));
    console.info(
      `[perf] fixture: ${CONTACTS} contacts / ${EDGES} edges seeded in ${ms(seeded.median)}; ` +
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
    const withGraph = await time(3, () => getNetworkOverview(conn, { includeGraph: true }));
    const without = await time(3, () => getNetworkOverview(conn, { includeGraph: false }));
    console.info(
      `[perf] GET /api/analytics (5k/20k): full ${ms(withGraph.median)} (min ${ms(withGraph.min)}), ` +
        `graph=0 ${ms(without.median)} (min ${ms(without.min)})`
    );

    const overview = await getNetworkOverview(conn, { includeGraph: false });
    expect(overview.metrics.totalContacts).toBe(CONTACTS);

    expect(withGraph.median).toBeLessThan(20_000);
    expect(without.median).toBeLessThan(10_000);
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
