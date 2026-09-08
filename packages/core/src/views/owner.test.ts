import { beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { hashViewerIp } from './privacy';
import { recentOwnerViewIpHashes, shouldMarkOwnerView } from './owner';

const fixture = createTestSqliteConn();
const conn = fixture.conn;

const NOW = new Date('2026-09-08T12:00:00.000Z');
const SALT = 'netpro-test-salt';
const OWNER_UA = 'Mozilla/5.0 (owner desktop)';

const OWNER_HASH = hashViewerIp({ ip: '203.0.113.10', userAgent: OWNER_UA, baseSalt: SALT, date: NOW });
const OTHER_HASH = hashViewerIp({ ip: '198.51.100.44', userAgent: OWNER_UA, baseSalt: SALT, date: NOW });

function insertView(over: {
  id: string;
  ipHash?: string | null;
  isOwnerView?: boolean;
  viewedAt?: string;
}): void {
  conn.db
    .insert(conn.schema.profileViews)
    .values({
      id: over.id,
      viewerIp: over.ipHash ?? null,
      viewerAgent: OWNER_UA,
      isBot: false,
      isOwnerView: over.isOwnerView ?? false,
      viewedPage: '/card',
      viewedAt: over.viewedAt ?? NOW.toISOString(),
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM profile_views;');
});

describe('owner-view detection (v2.5 phase 1)', () => {
  it('collects only confirmed-owner IP hashes from the lookback window', async () => {
    const hourAgo = new Date(NOW.getTime() - 3_600_000).toISOString();
    const yesterday = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    insertView({ id: 'owner-fresh', ipHash: OWNER_HASH, isOwnerView: true, viewedAt: hourAgo });
    // Too old: the daily salt would not even match today's hashes anyway.
    insertView({ id: 'owner-stale', ipHash: OWNER_HASH, isOwnerView: true, viewedAt: yesterday });
    // Same hash but not marked owner — a visitor must never leak in.
    insertView({ id: 'visitor-same-nat', ipHash: OWNER_HASH, isOwnerView: false });
    insertView({ id: 'visitor-other', ipHash: OTHER_HASH, isOwnerView: false });

    const hashes = await recentOwnerViewIpHashes(conn, { now: NOW });
    expect(hashes).toEqual([OWNER_HASH]);
  });

  it('returns an empty list when no owner view is on record', async () => {
    insertView({ id: 'v1', ipHash: OTHER_HASH, isOwnerView: false });
    expect(await recentOwnerViewIpHashes(conn, { now: NOW })).toEqual([]);
    expect(await recentOwnerViewIpHashes(conn, { now: NOW })).toEqual([]);
  });

  it('marks a view as the owner when the session says so, or the salted IP matches', async () => {
    // Authenticated owner session wins even with an unrecognized IP.
    expect(
      shouldMarkOwnerView({
        authenticatedOwnerSession: true,
        ipHash: OTHER_HASH,
        recentOwnerIpHashes: [],
      }),
    ).toBe(true);
    // No session, but the hash matches an owner view from earlier today.
    expect(
      shouldMarkOwnerView({
        authenticatedOwnerSession: false,
        ipHash: OWNER_HASH,
        recentOwnerIpHashes: [OWNER_HASH],
      }),
    ).toBe(true);
    // Unknown visitor.
    expect(
      shouldMarkOwnerView({
        authenticatedOwnerSession: false,
        ipHash: OTHER_HASH,
        recentOwnerIpHashes: [OWNER_HASH],
      }),
    ).toBe(false);
    // Request without an IP.
    expect(
      shouldMarkOwnerView({
        authenticatedOwnerSession: false,
        ipHash: null,
        recentOwnerIpHashes: [OWNER_HASH],
      }),
    ).toBe(false);
    // Nothing at all — defaults are safe.
    expect(
      shouldMarkOwnerView({ authenticatedOwnerSession: false, ipHash: null, recentOwnerIpHashes: [] }),
    ).toBe(false);
  });

  it('labels only: nothing here blocks, drops, or rate-limits a view', async () => {
    // The heuristic consumes rows and returns booleans; the table is untouched
    // except by the test's own inserts.
    const before = fixture.sqlite.prepare('SELECT count(*) AS n FROM profile_views').get();
    await recentOwnerViewIpHashes(conn, { now: NOW });
    shouldMarkOwnerView({
      authenticatedOwnerSession: false,
      ipHash: OWNER_HASH,
      recentOwnerIpHashes: [OWNER_HASH],
    });
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM profile_views').get()).toEqual(before);
  });
});
