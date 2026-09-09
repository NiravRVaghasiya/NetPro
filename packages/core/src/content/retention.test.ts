// v2.5 Phase 6 — content-snapshot retention: the 365-day window and the
// "latest per content always survives" rule.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { upsertContentItem } from './repository';
import {
  CONTENT_METRIC_RETENTION_DAYS,
  purgeExpiredContentMetrics,
} from './retention';

const fixture = createTestSqliteConn();
const conn = fixture.conn;

const NOW = new Date('2026-09-08T12:00:00.000Z');

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

async function seedContent(id: string): Promise<string> {
  const { item } = await upsertContentItem(
    conn,
    { url: `https://example.dev/blog/${id}`, title: `Piece ${id}`, platform: 'blog' },
    { now: NOW },
  );
  return item.id;
}

/** Snapshot ids are deterministic labels, not UUIDs — assertions compare them. */
function seedSnapshot(label: string, contentId: string, fetchedDaysAgo: number, views: number): void {
  conn.db
    .insert(conn.schema.contentMetrics)
    .values({
      id: `snap-${label}-${fetchedDaysAgo}`,
      contentId,
      fetchedAt: isoDaysAgo(fetchedDaysAgo),
      source: 'manual',
      views,
    })
    .run();
}

function snapshotIds(): string[] {
  return (
    fixture
      .sqlite.prepare('SELECT id FROM content_metrics ORDER BY id')
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items;'
  );
});

afterAll(() => fixture.sqlite.close());

describe('purgeExpiredContentMetrics (v2.5 phase 6)', () => {
  it('defaults to a 365-day window and deletes only older snapshots', async () => {
    expect(CONTENT_METRIC_RETENTION_DAYS).toBe(365);
    const id = await seedContent('x');
    seedSnapshot('x', id, 400, 10); // well past the window
    seedSnapshot('x', id, 364, 20); // inside the window
    seedSnapshot('x', id, 0, 30); // today

    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 1 });
    expect(snapshotIds()).toEqual([
      'snap-x-0',
      'snap-x-364',
    ]);

    // Idempotent: a second run deletes nothing.
    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 0 });
  });

  it('keeps the latest snapshot per content item even when it is older than the window', async () => {
    const id = await seedContent('stale');
    // The whole history of this piece predates the window: the newest
    // snapshot (400 d) must still survive, the older one (500 d) must not.
    seedSnapshot('stale', id, 500, 10);
    seedSnapshot('stale', id, 400, 20);

    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 1 });
    expect(snapshotIds()).toEqual(['snap-stale-400']);
  });

  it('applies the keep-latest rule per item, not per table', async () => {
    const a = await seedContent('a');
    const b = await seedContent('b');
    // a: newest is fresh, older one is expired → older deleted.
    seedSnapshot('a', a, 0, 1);
    seedSnapshot('a', a, 400, 1);
    // b: newest is expired, older is expired → only the newest survives.
    seedSnapshot('b', b, 500, 1);
    seedSnapshot('b', b, 400, 1);

    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 2 });
    expect(snapshotIds()).toEqual(['snap-a-0', 'snap-b-400']);
  });

  it('keeps ties for the newest timestamp (ambiguous latest is not guessable)', async () => {
    const id = await seedContent('tie');
    const at = isoDaysAgo(400); // both past the window, both "latest"
    conn.db
      .insert(conn.schema.contentMetrics)
      .values([
        {
          id: 'snap-tie-1',
          contentId: id,
          fetchedAt: at,
          source: 'manual',
          views: 1,
        },
        {
          id: 'snap-tie-2',
          contentId: id,
          fetchedAt: at,
          source: 'manual',
          views: 2,
        },
        {
          id: 'snap-tie-0',
          contentId: id,
          fetchedAt: isoDaysAgo(500),
          source: 'manual',
          views: 1,
        },
      ])
      .run();

    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 1 });
    expect(snapshotIds()).toEqual(['snap-tie-1', 'snap-tie-2']);
  });

  it('deletes nothing on an empty library and never deletes a fresh-only table', async () => {
    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 0 });
    const id = await seedContent('fresh');
    seedSnapshot('fresh', id, 0, 7);
    expect(await purgeExpiredContentMetrics(conn, { now: NOW })).toEqual({ deleted: 0 });
    expect(snapshotIds()).toEqual(['snap-fresh-0']);
  });

  it('honors a custom window', async () => {
    const id = await seedContent('w');
    seedSnapshot('w', id, 100, 1);
    seedSnapshot('w', id, 10, 1);
    expect(await purgeExpiredContentMetrics(conn, { now: NOW, olderThanDays: 30 })).toEqual({
      deleted: 1,
    });
    expect(snapshotIds()).toEqual(['snap-w-10']);
  });

  it('rejects nonsense windows instead of deleting everything', async () => {
    const id = await seedContent('r');
    seedSnapshot('r', id, 400, 1);
    seedSnapshot('r', id, 500, 1);
    await expect(
      purgeExpiredContentMetrics(conn, { now: NOW, olderThanDays: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      purgeExpiredContentMetrics(conn, { now: NOW, olderThanDays: Number.NaN }),
    ).rejects.toThrow(/positive/);
    expect(snapshotIds()).toHaveLength(2); // nothing was deleted
  });
});
