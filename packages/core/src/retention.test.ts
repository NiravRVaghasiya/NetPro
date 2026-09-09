// v2.5 Phase 6 — the daily retention purge: composition of the two
// retention queries, the 24 h "last run" guard over `activity_log`, and the
// one audit row per run carrying the deleted counts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { upsertContentItem } from './content/repository';
import {
  RETENTION_PURGE_ACTION,
  RETENTION_PURGE_INTERVAL_MS,
  runRetentionPurge,
} from './retention';

const fixture = createTestSqliteConn();
const conn = fixture.conn;

const NOW = new Date('2026-09-08T12:00:00.000Z');

function isoDaysAgo(days: number, extraMs = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 - extraMs).toISOString();
}

function seedView(id: string, viewedDaysAgo: number): void {
  conn.db
    .insert(conn.schema.profileViews)
    .values({
      id,
      isBot: false,
      isOwnerView: false,
      viewedPage: '/card',
      viewedAt: isoDaysAgo(viewedDaysAgo),
    })
    .run();
}

async function seedSnapshot(contentId: string, id: string, fetchedDaysAgo: number): Promise<void> {
  conn.db
    .insert(conn.schema.contentMetrics)
    .values({ id, contentId, fetchedAt: isoDaysAgo(fetchedDaysAgo), source: 'manual', views: 1 })
    .run();
}

function seedPurgeRun(daysAgo: number): void {
  conn.db
    .insert(conn.schema.activityLog)
    .values({
      id: `purge-run-${daysAgo}`,
      action: RETENTION_PURGE_ACTION,
      entityType: 'retention',
      metadata: JSON.stringify({ profileViewsDeleted: 0, contentMetricsDeleted: 0 }),
      createdAt: isoDaysAgo(daysAgo),
    })
    .run();
}

function purgeLogRows(): Array<{ created_at: string; metadata: string | null }> {
  return fixture
    .sqlite
    .prepare(
      `SELECT created_at, metadata FROM activity_log
       WHERE action = ? ORDER BY created_at`,
    )
    .all(RETENTION_PURGE_ACTION) as Array<{ created_at: string; metadata: string | null }>;
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM profile_views; DELETE FROM activity_log;'
  );
});

afterAll(() => fixture.sqlite.close());

describe('runRetentionPurge (v2.5 phase 6)', () => {
  it('purges both bounded tables and writes exactly one audit row with the counts', async () => {
    seedView('old-view', 120); // past the 90-day window
    seedView('fresh-view', 5);
    const { item } = await upsertContentItem(
      conn,
      { url: 'https://example.dev/blog/retention', title: 'R', platform: 'blog' },
      { now: NOW },
    );
    await seedSnapshot(item.id, 'snap-old', 400);
    await seedSnapshot(item.id, 'snap-fresh', 3);

    const result = await runRetentionPurge(conn, { now: NOW });

    expect(result).toMatchObject({
      ran: true,
      skipped: null,
      lastRunAt: null,
      profileViewsDeleted: 1,
      contentMetricsDeleted: 1,
      viewRetentionDays: 90,
      contentMetricRetentionDays: 365,
    });

    // The raw rows that are inside their windows survive.
    const views = (
      fixture.sqlite.prepare('SELECT id FROM profile_views ORDER BY id').all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    expect(views).toEqual(['fresh-view']);
    const snaps = (
      fixture.sqlite
        .prepare('SELECT id FROM content_metrics ORDER BY id')
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(snaps).toEqual(['snap-fresh']);

    // One audit row, counts in metadata, never one row per deleted row.
    const rows = purgeLogRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({
      profileViewsDeleted: 1,
      contentMetricsDeleted: 1,
      viewRetentionDays: 90,
      contentMetricRetentionDays: 365,
    });
  });

  it('skips a second run inside the 24 h interval', async () => {
    seedView('old-view', 120);
    expect(await runRetentionPurge(conn, { now: NOW })).toMatchObject({
      ran: true,
      profileViewsDeleted: 1,
    });

    const again = await runRetentionPurge(conn, { now: NOW });
    expect(again).toMatchObject({
      ran: false,
      skipped: 'recent',
      lastRunAt: purgeLogRows()[0]!.created_at,
      profileViewsDeleted: 0,
      contentMetricsDeleted: 0,
    });
    expect(purgeLogRows()).toHaveLength(1); // no duplicate audit row

    // 24 h later (plus a millisecond) the job is due again.
    const later = new Date(NOW.getTime() + RETENTION_PURGE_INTERVAL_MS + 1);
    expect(await runRetentionPurge(conn, { now: later })).toMatchObject({ ran: true });
    expect(purgeLogRows()).toHaveLength(2);
  });

  it('treats a run exactly at the interval boundary as due', async () => {
    seedPurgeRun(1); // exactly 24 h ago
    expect(await runRetentionPurge(conn, { now: NOW })).toMatchObject({ ran: true });
  });

  it('honors force and a zero interval for manual re-runs', async () => {
    expect(await runRetentionPurge(conn, { now: NOW })).toMatchObject({ ran: true });

    // The guard would skip this one…
    expect(await runRetentionPurge(conn, { now: NOW })).toMatchObject({
      ran: false,
      skipped: 'recent',
    });
    // …unless forced (the last-run marker is still reported).
    expect(await runRetentionPurge(conn, { now: NOW, force: true })).toMatchObject({
      ran: true,
      lastRunAt: NOW.toISOString(),
    });

    // A zero interval disables the guard entirely.
    expect(
      await runRetentionPurge(conn, { now: NOW, minIntervalMs: 0 }),
    ).toMatchObject({ ran: true });
  });

  it('ignores activity_log rows from other actions when deciding cadence', async () => {
    conn.db
      .insert(conn.schema.activityLog)
      .values({
        id: 'other-action',
        action: 'crm.interaction.logged',
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(await runRetentionPurge(conn, { now: NOW })).toMatchObject({
      ran: true,
      lastRunAt: null,
    });
  });

  it('forwards custom retention windows to both queries', async () => {
    seedView('between', 30); // inside the default 90 d, outside 7 d
    const { item } = await upsertContentItem(
      conn,
      { url: 'https://example.dev/blog/win', title: 'W', platform: 'blog' },
      { now: NOW },
    );
    // Two snapshots: the 30-d one is inside the default 365 d window but
    // outside the custom 7 d one; the 3-d one is the latest (and fresh).
    await seedSnapshot(item.id, 'snap-30', 30);
    await seedSnapshot(item.id, 'snap-3', 3);

    const result = await runRetentionPurge(conn, {
      now: NOW,
      viewRetentionDays: 7,
      contentMetricRetentionDays: 7,
    });
    expect(result).toMatchObject({
      ran: true,
      profileViewsDeleted: 1,
      contentMetricsDeleted: 1,
      viewRetentionDays: 7,
      contentMetricRetentionDays: 7,
    });
    const snaps = (
      fixture.sqlite
        .prepare('SELECT id FROM content_metrics ORDER BY id')
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(snaps).toEqual(['snap-3']);
    expect(JSON.parse(purgeLogRows()[0]!.metadata!)).toMatchObject({
      viewRetentionDays: 7,
      contentMetricRetentionDays: 7,
    });
  });

  it('rejects a negative interval', async () => {
    await expect(runRetentionPurge(conn, { now: NOW, minIntervalMs: -1 })).rejects.toThrow(
      /non-negative/,
    );
  });
});
