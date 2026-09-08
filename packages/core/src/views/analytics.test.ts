import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteConn } from '@netpro/db';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  VIEWS_DEFAULT_DAYS,
  VIEWS_MAX_DAYS,
  ViewsError,
  foldReferrerHosts,
  getRecentViews,
  getTopReferrers,
  getViewerContactMatches,
  getViewStats,
  getViewsOverview,
} from './analytics';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const iso = (daysAgo: number, hour = 12): string =>
  new Date(Date.UTC(2026, 8, 8 - daysAgo, hour, 0, 0)).toISOString();

const fixture = createTestSqliteConn();
const conn: SqliteConn = fixture.conn;

interface SeedView {
  id: string;
  daysAgo?: number;
  hour?: number;
  at?: string;
  fingerprint?: string | null;
  ip?: string | null;
  session?: string;
  page?: string;
  referrer?: string | null;
  country?: string | null;
  city?: string | null;
  durationMs?: number | null;
  bot?: boolean;
  owner?: boolean;
  contact?: string | null;
}

let n = 0;
function seedView(v: SeedView): void {
  n += 1;
  conn.db
    .insert(conn.schema.profileViews)
    .values({
      id: v.id,
      viewerIp: v.ip === undefined ? `aabbccddeeff${String(n).padStart(4, '0')}`.slice(0, 16) : v.ip,
      viewerAgent: 'Mozilla/5.0 test',
      referrer: v.referrer === undefined ? null : v.referrer,
      resolvedContact: v.contact ?? null,
      viewerFingerprint: v.fingerprint === undefined ? `fp${v.id}` : v.fingerprint,
      isBot: v.bot ?? false,
      isOwnerView: v.owner ?? false,
      sessionId: v.session ?? `sess-${v.id}`,
      durationMs: v.durationMs ?? null,
      viewedPage: v.page ?? '/card',
      viewedAt: v.at ?? iso(v.daysAgo ?? 0, v.hour ?? 12),
      country: v.country ?? null,
      city: v.city ?? null,
    })
    .run();
}

function seedContact(id: string, fullName: string, deleted: boolean): void {
  conn.db
    .insert(conn.schema.contacts)
    .values({
      id,
      fullName,
      company: `${fullName} Inc`,
      role: 'Friend',
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      deletedAt: deleted ? NOW.toISOString() : null,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM profile_views; DELETE FROM contacts;');
  n = 0;
});
afterAll(() => fixture.sqlite.close());

/** The hand-built fixture every aggregation test below counts against. */
function seedMixedFixture(): void {
  seedContact('ada', 'Ada Lovelace', false);
  seedContact('ghost', 'Gone Person', true); // soft-deleted: must never surface
  seedView({ id: 'v1', daysAgo: 0, referrer: 'https://blog.example/post/1', country: 'GB', contact: 'ada', durationMs: 1000 });
  seedView({ id: 'v2', daysAgo: 0, hour: 11, referrer: 'https://blog.example/post/2', country: 'GB' });
  seedView({ id: 'v3', daysAgo: 1, referrer: 'https://news.example/x', country: 'US', page: 'blog', contact: 'ada', durationMs: 3000 });
  seedView({ id: 'v4', daysAgo: 2, country: 'US', page: 'portfolio' }); // direct, no referrer
  seedView({ id: 'v5', daysAgo: 2, hour: 14, referrer: 'https://blog.example/post/1', fingerprint: 'fpv1', ip: 'shared-ip-hash-01' }); // same fingerprint as v1
  seedView({ id: 'v6', daysAgo: 40 }); // outside the 30d default, inside 90d
  seedView({ id: 'v7', daysAgo: 91 }); // purged territory: outside even the 90d cap
  seedView({ id: 'v8', daysAgo: 0, bot: true, referrer: 'https://botfarm.example/' });
  seedView({ id: 'v9', daysAgo: 0, owner: true });
  seedView({ id: 'v10', daysAgo: 0, contact: 'ghost' }); // resolved to a deleted contact
  seedView({ id: 'v11', daysAgo: 0, fingerprint: null, ip: 'dnt-ip-hash-0001' }); // DNT minimal row
  seedView({ id: 'v12', daysAgo: 0, fingerprint: null, ip: 'dnt-ip-hash-0001', session: 'sess-v12' }); // same IP, other session
  seedView({ id: 'v13', daysAgo: 0, fingerprint: null, ip: null, session: 'sess-lonely' }); // no IP at all
  seedView({ id: 'v14', at: new Date(NOW.getTime() + 3_600_000).toISOString() }); // future: clock skew, out of window
}

describe('getViewStats (v2.5 phase 3)', () => {
  it('counts the default 30-day window, excluding bots, owner views and the future', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { now: NOW });
    expect(stats.window).toEqual({
      days: VIEWS_DEFAULT_DAYS,
      since: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      until: NOW.toISOString(),
    });
    // v1–v5, v10–v13: v6 is 40d old, v7 is 91d, v8/v9 filtered, v14 future.
    expect(stats.totals.views).toBe(9);
    expect(stats.excluded).toEqual({ bots: 1, ownerViews: 1 });
    expect(stats.filters).toEqual({ includeBots: false, includeOwnerViews: false });
  });

  it('counts unique viewers with the fingerprint → IP → session fallback', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { now: NOW });
    // fpv1 (v1+v5), fpv2, fpv3, fpv4, fpv10, dnt-ip-hash-0001 (v11+v12), sess-lonely (v13).
    expect(stats.totals.uniqueViewers).toBe(7);
  });

  it('widens the window to 90 days and reports resolved contacts + avg duration', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { days: 90, now: NOW });
    expect(stats.totals.views).toBe(10); // +v6; v7 (91d) still out
    // v1, v3 → ada; v10 → ghost (deleted, but the raw count is honest).
    expect(stats.totals.resolvedContacts).toBe(2);
    // Only v1 (1000) and v3 (3000) reported a duration.
    expect(stats.totals.avgDurationMs).toBe(2000);
  });

  it('folds referrers to domains and keeps (direct) and (unknown) buckets', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { now: NOW });
    // Paths fold under their host; (direct) = v4, v10, v11, v12, v13.
    expect(stats.byReferrer).toEqual([
      { value: '(direct)', count: 5, share: 5 / 9 },
      { value: 'blog.example', count: 3, share: 3 / 9 },
      { value: 'news.example', count: 1, share: 1 / 9 },
    ]);
    expect(stats.byCountry).toEqual([
      { value: '(unknown)', count: 5, share: 5 / 9 },
      { value: 'GB', count: 2, share: 2 / 9 },
      { value: 'US', count: 2, share: 2 / 9 },
    ]);
    expect(stats.byPage).toEqual([
      { value: '/card', count: 7, share: 7 / 9 },
      { value: 'blog', count: 1, share: 1 / 9 },
      { value: 'portfolio', count: 1, share: 1 / 9 },
    ]);
  });

  it('zero-fills the daily series across the whole window', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { days: 7, now: NOW });
    expect(stats.series).toHaveLength(7);
    expect(stats.series[0]).toEqual({ date: '2026-09-02', views: 0, unique: 0 });
    // 2026-09-08: v1, v2, v10–v13 (v3 fell on 09-07).
    expect(stats.series[6]).toEqual({ date: '2026-09-08', views: 6, unique: 5 });
    expect(stats.series.find((p) => p.date === '2026-09-07')).toEqual({
      date: '2026-09-07',
      views: 1,
      unique: 1,
    });
  });

  it('opts bots and owner views back in when asked, zeroing the excluded counts', async () => {
    seedMixedFixture();
    const stats = await getViewStats(conn, { now: NOW, includeBots: true, includeOwnerViews: true });
    expect(stats.totals.views).toBe(11);
    expect(stats.excluded).toEqual({ bots: 0, ownerViews: 0 });
    expect(stats.byReferrer.find((b) => b.value === 'botfarm.example')?.count).toBe(1);
  });

  it('returns zeroes — never nulls or missing days — for an empty database', async () => {
    const stats = await getViewStats(conn, { days: 7, now: NOW });
    expect(stats.totals).toEqual({ views: 0, uniqueViewers: 0, resolvedContacts: 0, avgDurationMs: null });
    expect(stats.excluded).toEqual({ bots: 0, ownerViews: 0 });
    expect(stats.series).toHaveLength(7);
    expect(stats.series.every((p) => p.views === 0 && p.unique === 0)).toBe(true);
    expect(stats.byReferrer).toEqual([]);
    expect(stats.byCountry).toEqual([]);
    expect(stats.byPage).toEqual([]);
  });

  it.each([{ days: 0 }, { days: 91 }, { days: 365 }, { days: 1.5 }, { days: Number.NaN }])(
    'rejects out-of-window days=%j (retention is 90 days, silence would lie)',
    async (opts) => {
      await expect(getViewStats(conn, { ...opts, now: NOW })).rejects.toThrow(ViewsError);
      await expect(getViewStats(conn, { ...opts, now: NOW })).rejects.toThrow(/days must be/);
    },
  );

  it.each([{ limit: 0 }, { limit: 51 }, { limit: -3 }])('rejects limit=%j', async (opts) => {
    await expect(getViewStats(conn, { ...opts, now: NOW })).rejects.toThrow(/limit must be/);
  });

  it('accepts the boundary values days=1 and days=90', async () => {
    seedMixedFixture();
    expect((await getViewStats(conn, { days: 1, now: NOW })).totals.views).toBe(7);
    expect((await getViewStats(conn, { days: 90, now: NOW })).totals.views).toBe(10);
    expect(VIEWS_MAX_DAYS).toBe(90);
  });

  it('handles 10k views within the plan budget (measured, loose assertion)', async () => {
    // 10k rows, one per insert — the measured cost is the query, not the seed.
    for (let i = 0; i < 10_000; i++) {
      seedView({
        id: `bulk-${i}`,
        daysAgo: i % 30,
        fingerprint: `bulk-fp-${i % 3000}`,
        referrer: i % 3 === 0 ? 'https://blog.example/p' : null,
        country: i % 2 === 0 ? 'GB' : 'US',
      });
    }
    const t0 = performance.now();
    const stats = await getViewStats(conn, { now: NOW });
    const elapsed = performance.now() - t0;
    expect(stats.totals.views).toBe(10_000);
    expect(stats.totals.uniqueViewers).toBe(3000);
    expect(stats.series).toHaveLength(30);
    // The plan asks for <100ms on SQLite; CI runners are noisy, so the gate
    // is 20× looser and the real number is recorded in the progress doc.
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});

describe('foldReferrerHosts (v2.5 phase 3)', () => {
  it('merges paths under one host, lowercases, and buckets direct traffic', () => {
    expect(
      foldReferrerHosts([
        { referrer: 'https://Blog.Example/a', count: 2 },
        { referrer: 'https://blog.example/b?x=1', count: 3 },
        { referrer: null, count: 1 },
      ]),
    ).toEqual(
      new Map([
        ['blog.example', 5],
        ['(direct)', 1],
      ]),
    );
  });

  it('keeps unparseable legacy values as their own bucket instead of dropping them', () => {
    expect(foldReferrerHosts([{ referrer: 'not a url at all', count: 4 }])).toEqual(
      new Map([['not a url at all', 4]]),
    );
  });
});

describe('getRecentViews (v2.5 phase 3)', () => {
  it('returns the newest-first timeline with resolved live contacts', async () => {
    seedMixedFixture();
    const page = await getRecentViews(conn, { now: NOW });
    expect(page.total).toBe(9);
    expect(page.limit).toBe(10);
    expect(page.offset).toBe(0);
    // v13 (hour 12, highest id among the hour-12s) sorts first on the id tiebreak.
    expect(page.views[0]?.id).toBe('v13');
    expect(page.views.map((v) => v.viewedAt)).toEqual(
      [...page.views.map((v) => v.viewedAt)].sort().reverse(),
    );
    const adaView = page.views.find((v) => v.id === 'v1');
    expect(adaView?.resolvedContact).toEqual({
      id: 'ada',
      fullName: 'Ada Lovelace',
      company: 'Ada Lovelace Inc',
      role: 'Friend',
    });
  });

  it('renders views for soft-deleted contacts as unattributed', async () => {
    seedMixedFixture();
    const page = await getRecentViews(conn, { now: NOW });
    expect(page.views.find((v) => v.id === 'v10')?.resolvedContact).toBeNull();
  });

  it('paginates with limit/offset and honors the window + filters', async () => {
    seedMixedFixture();
    const first = await getRecentViews(conn, { now: NOW, limit: 3, offset: 0 });
    const second = await getRecentViews(conn, { now: NOW, limit: 3, offset: 3 });
    expect(first.views).toHaveLength(3);
    expect(second.views).toHaveLength(3);
    expect(first.views.map((v) => v.id)).not.toEqual(second.views.map((v) => v.id));
    expect(first.total).toBe(9);
    expect(second.total).toBe(9);
    const bots = await getRecentViews(conn, { now: NOW, includeBots: true, limit: 100 });
    expect(bots.total).toBe(10);
    expect(bots.views.some((v) => v.isBot)).toBe(true);
  });

  it('rejects bad pagination without touching the database shape', async () => {
    await expect(getRecentViews(conn, { now: NOW, offset: -1 })).rejects.toThrow(/offset must be/);
    await expect(getRecentViews(conn, { now: NOW, limit: 101 })).rejects.toThrow(/limit must be/);
    await expect(getRecentViews(conn, { now: NOW, days: 91 })).rejects.toThrow(/days must be/);
  });
});

describe('getTopReferrers (v2.5 phase 3)', () => {
  it('ranks hosts without the cost of the full stats payload', async () => {
    seedMixedFixture();
    expect(await getTopReferrers(conn, { now: NOW })).toEqual([
      { value: '(direct)', count: 5, share: 5 / 9 },
      { value: 'blog.example', count: 3, share: 3 / 9 },
      { value: 'news.example', count: 1, share: 1 / 9 },
    ]);
    expect(await getTopReferrers(conn, { now: NOW, limit: 1 })).toEqual([
      { value: '(direct)', count: 5, share: 5 / 9 },
    ]);
  });

  it('shares the bot/owner exclusion with getViewStats', async () => {
    seedMixedFixture();
    const def = await getTopReferrers(conn, { now: NOW });
    expect(def.some((r) => r.value === 'botfarm.example')).toBe(false);
    const withBots = await getTopReferrers(conn, { now: NOW, includeBots: true });
    expect(withBots.some((r) => r.value === 'botfarm.example')).toBe(true);
  });
});

describe('getViewerContactMatches (v2.5 phase 3)', () => {
  it('names known visitors newest-first, skipping deleted contacts and bots', async () => {
    seedMixedFixture();
    // A bot following a signed link is not "Ada viewed your card".
    seedView({ id: 'vbot', daysAgo: 0, bot: true, contact: 'ada' });
    const matches = await getViewerContactMatches(conn, { now: NOW });
    expect(matches.total).toBe(2); // v1 + v3; v10's contact is deleted
    expect(matches.matches.map((m) => m.viewId)).toEqual(['v1', 'v3']);
    expect(matches.matches[0]?.contact.fullName).toBe('Ada Lovelace');
  });

  it('is empty — not an error — when nobody signed in via a link', async () => {
    seedView({ id: 'solo', daysAgo: 0 });
    expect(await getViewerContactMatches(conn, { now: NOW })).toEqual({ matches: [], total: 0 });
  });
});

describe('getViewsOverview (v2.5 phase 3)', () => {
  it('composes stats + recent + matches with one shared window', async () => {
    seedMixedFixture();
    const overview = await getViewsOverview(conn, { days: 7, limit: 5, now: NOW });
    expect(overview.stats.window.days).toBe(7);
    expect(overview.stats.totals.views).toBe(9);
    expect(overview.recent.total).toBe(9);
    expect(overview.recent.views).toHaveLength(5);
    expect(overview.matches.total).toBe(2);
  });
});
