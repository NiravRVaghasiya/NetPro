// v2.5 Phase 6 — the SQLite performance budget.
//
// The plan pins three budgets at one fixture size:
//
//     10k views + 1k content items + 5k metrics
//       dashboard  GET /api/analytics   < 500 ms
//       views      GET /api/card/views  < 100 ms
//       content    GET /api/content     < 100 ms
//
// Measured at the core entry points those routes call — `getNetworkOverview`
// (the full dashboard payload, graph included), `getViewsOverview`, and
// `listContentSummaries` — the same measure-and-record discipline as
// `postgres.perf.test.ts`, but on the portable dialect so it runs in every
// `npm test` (no server, no network, hermetic in-memory SQLite).
//
// The assertions are deliberately loose — a 10× smoke alarm, not a
// benchmark. A 10× regression has to fail the build; 15% jitter must not.
// The interesting output is the recorded numbers (progress doc), not the
// gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { getNetworkOverview } from './analytics';
import { getContentOverview, listContentSummaries } from './content/repository';
import { getViewsOverview } from './views/analytics';

const fixture = createTestSqliteConn();
const conn = fixture.conn;
const sqlite = fixture.sqlite;

const NOW = new Date('2026-09-08T12:00:00.000Z');
const CONTACTS = 500;
const EDGES = 100;
const VIEWS = 10_000;
const CONTENT_ITEMS = 1_000;
const METRICS = 5_000;

/** Deterministic LCG — the same fixture on every machine and run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function isoAgo(daysAgo: number, hoursAgo = 0): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();
}

/**
 * Bulk raw-SQL insert in chunks — the seed cost must not pollute the
 * measured queries (the measured cost is the query, not the fixture).
 */
function bulkInsert(columns: string, rows: Array<Array<string | number | null>>): void {
  const chunk = 500;
  sqlite.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += chunk) {
      const values = rows
        .slice(i, i + chunk)
        .map((r) => `(${r.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`)).join(',')})`)
        .join(',');
      sqlite.prepare(`INSERT INTO ${tableFor(columns)} (${columns}) VALUES ${values}`).run();
    }
  } finally {
    sqlite.exec('COMMIT');
  }
}

// The column list picks the table — keeps the seed code readable.
function tableFor(columns: string): string {
  if (columns.includes('viewer_fingerprint')) return 'profile_views';
  if (columns.includes('url_norm')) return 'content_items';
  if (columns.includes('content_id')) return 'content_metrics';
  if (columns.includes('source_id')) return 'edges';
  return 'contacts';
}

const COMPANIES = ['Stripe', 'Figma', 'Vercel', 'Monzo', 'Klarna', 'Linear'];
const INDUSTRIES = ['fintech', 'devtools', 'design', 'commerce'];
const REFERRERS = ['https://blog.example/post/1', 'https://blog.example/post/2', 'https://news.ycombinator.com', 'https://x.com'];
const COUNTRIES = ['GB', 'US', 'DE', 'IN', null];
const PLATFORMS = ['blog', 'devto', 'twitter', 'github'];
const HEX = '0123456789abcdef';

function hex16(seed: number): string {
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < 16; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    out += HEX.charAt(s % 16);
  }
  return out;
}

beforeAll(() => {
  const rand = rng(20260908);

  // ── contacts + edges (keeps the graph section of the overview realistic)
  const contactCols = 'id,full_name,source,company,industry,role,relationship_score,last_interaction,created_at,updated_at';
  const contacts: Array<Array<string | number | null>> = [];
  for (let i = 0; i < CONTACTS; i++) {
    const daysAgo = Math.floor(rand() * 365);
    const active = rand() < 0.4;
    contacts.push([
      `c${i}`,
      `Contact ${i}`,
      'perf',
      COMPANIES[i % COMPANIES.length]!,
      INDUSTRIES[i % INDUSTRIES.length]!,
      'Engineer',
      Math.round(rand() * 100) / 100,
      active ? isoAgo(Math.floor(rand() * 30)) : isoAgo(200),
      isoAgo(daysAgo),
      isoAgo(daysAgo),
    ]);
  }
  bulkInsert(contactCols, contacts);

  const edgeCols = 'id,source_id,target_id,relation,strength,bidirectional,source,confidence,status,discovered_at,updated_at';
  const edges: Array<Array<string | number | null>> = [];
  for (let i = 0; i < EDGES; i++) {
    const a = Math.floor(rand() * CONTACTS);
    let b = Math.floor(rand() * CONTACTS);
    if (b === a) b = (b + 1) % CONTACTS;
    edges.push([
      `e${i}`,
      `c${a}`,
      `c${b}`,
      'colleague',
      0.5,
      1,
      'manual',
      1,
      'confirmed',
      isoAgo(50),
      isoAgo(50),
    ]);
  }
  bulkInsert(edgeCols, edges);

  // ── 10k profile views across the full 90-day window
  const viewCols =
    'id,viewer_ip,referrer,resolved_contact,viewer_fingerprint,is_bot,is_owner_view,session_id,duration_ms,viewed_page,viewed_at,country';
  const views: Array<Array<string | number | null>> = [];
  for (let i = 0; i < VIEWS; i++) {
    views.push([
      `v${i}`,
      hex16(i + 1),
      i % 4 === 0 ? null : REFERRERS[i % REFERRERS.length]!,
      i % 25 === 0 ? `c${i % CONTACTS}` : null,
      hex16(70_000 + (i % 1_000)),
      i % 50 === 0 ? 1 : 0,
      i % 97 === 0 ? 1 : 0,
      `sess-${i % 500}`,
      i % 5 === 0 ? null : (i % 60_000) + 1,
      '/card',
      isoAgo(i % 90, i % 24),
      COUNTRIES[i % COUNTRIES.length] ?? null,
    ]);
  }
  bulkInsert(viewCols, views);

  // ── 1k content items across a year, ~10% undated
  const itemCols =
    'id,url,url_norm,title,platform,type,published_at,author,tags,summary,source,created_at,updated_at';
  const items: Array<Array<string | number | null>> = [];
  for (let i = 0; i < CONTENT_ITEMS; i++) {
    const undated = i % 10 === 0;
    const url = `https://blog.example/posts/${i}`;
    items.push([
      `ci${i}`,
      url,
      url,
      `Post ${i}`,
      PLATFORMS[i % PLATFORMS.length]!,
      null,
      undated ? null : isoAgo(i % 360),
      `Author ${i % 20}`,
      '[]',
      null,
      'manual',
      isoAgo(i % 360),
      isoAgo(i % 360),
    ]);
  }
  bulkInsert(itemCols, items);

  // ── 5k snapshots, five per item, across a year
  const metricCols = 'id,content_id,fetched_at,source,views,likes,raw_payload,created_at';
  const metrics: Array<Array<string | number | null>> = [];
  for (let i = 0; i < METRICS; i++) {
    metrics.push([
      `cm${i}`,
      `ci${i % CONTENT_ITEMS}`,
      isoAgo(i % 360),
      'manual',
      (i * 37) % 5_000,
      (i * 13) % 200,
      null,
      isoAgo(i % 360),
    ]);
  }
  bulkInsert(metricCols, metrics);
});

afterAll(() => fixture.sqlite.close());

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, ms: performance.now() - t0 }));
}

describe('v2.5 Phase 6 — SQLite performance budget (10k views / 1k content / 5k metrics)', () => {
  it('fixture size sanity', () => {
    expect(sqlite.prepare('SELECT COUNT(*) n FROM profile_views').get() as { n: number }).toEqual({
      n: VIEWS,
    });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM content_items').get() as { n: number }).toEqual({
      n: CONTENT_ITEMS,
    });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM content_metrics').get() as { n: number }).toEqual({
      n: METRICS,
    });
  });

  it('dashboard GET /api/analytics (getNetworkOverview) under 500 ms', async () => {
    // Warm the query plans; the budget is a steady-state request.
    await getNetworkOverview(conn, { now: NOW });
    const { value, ms } = await timed(() => getNetworkOverview(conn, { now: NOW }));
    console.info(`[perf] dashboard GET /api/analytics: ${ms.toFixed(1)} ms (budget 500 ms)`);
    expect(value.metrics.totalContacts).toBe(CONTACTS);
    expect(value.views).toBeDefined();
    expect(value.content).toMatchObject({ items: CONTENT_ITEMS });
    // 10× smoke alarm, not a benchmark (see header).
    expect(ms).toBeLessThan(5_000);
  });

  it('views GET /api/card/views (getViewsOverview) under 100 ms', async () => {
    await getViewsOverview(conn, { days: 30, now: NOW });
    const { value, ms } = await timed(() => getViewsOverview(conn, { days: 30, now: NOW }));
    console.info(`[perf] views GET /api/card/views: ${ms.toFixed(1)} ms (budget 100 ms)`);
    expect(value.stats.series).toHaveLength(30);
    // Bots + owner views are excluded from the count, reported alongside.
    expect(value.stats.totals.views).toBeLessThan(VIEWS);
    expect(value.stats.excluded.bots + value.stats.excluded.ownerViews).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1_000);
  });

  it('content GET /api/content (listContentSummaries) under 100 ms', async () => {
    await listContentSummaries(conn, { limit: 50, now: NOW });
    const { value, ms } = await timed(() => listContentSummaries(conn, { limit: 50, now: NOW }));
    console.info(`[perf] content GET /api/content: ${ms.toFixed(1)} ms (budget 100 ms)`);
    expect(value.total).toBe(CONTENT_ITEMS);
    expect(value.items).toHaveLength(50);
    expect(ms).toBeLessThan(1_000);
  });

  it('records the dashboard content path (getContentOverview) for the progress doc', async () => {
    await getContentOverview(conn, { now: NOW });
    const { value, ms } = await timed(() => getContentOverview(conn, { now: NOW }));
    console.info(`[perf] content overview (dashboard strip): ${ms.toFixed(1)} ms (recorded)`);
    expect(value.items).toBe(CONTENT_ITEMS);
    expect(ms).toBeLessThan(1_000);
  });
});
