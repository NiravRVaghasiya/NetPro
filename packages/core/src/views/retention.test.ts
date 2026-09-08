import { beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { VIEW_RETENTION_DAYS, purgeExpiredProfileViews } from './retention';

const fixture = createTestSqliteConn();
const conn = fixture.conn;

const NOW = new Date('2026-09-08T12:00:00.000Z');

function insertView(id: string, viewedAt: string): void {
  conn.db
    .insert(conn.schema.profileViews)
    .values({ id, viewerIp: null, isBot: false, isOwnerView: false, viewedPage: '/card', viewedAt })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM profile_views;');
});

describe('profile-view retention (v2.5 phase 1)', () => {
  it('defaults to a 90-day window and deletes only older raw rows', async () => {
    expect(VIEW_RETENTION_DAYS).toBe(90);
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    insertView('old', '2026-01-01T00:00:00.000Z'); // ~8 months back
    insertView('boundary-minus-1ms', new Date(cutoff.getTime() - 1).toISOString());
    insertView('boundary-exact', cutoff.toISOString()); // kept: delete is strictly older
    insertView('fresh', NOW.toISOString());
    insertView('future', '2026-10-01T00:00:00.000Z');

    const first = await purgeExpiredProfileViews(conn, { now: NOW });
    expect(first).toEqual({ deleted: 2 });
    expect(
      fixture.sqlite.prepare('SELECT id FROM profile_views ORDER BY id').all(),
    ).toEqual([
      { id: 'boundary-exact' },
      { id: 'fresh' },
      { id: 'future' },
    ]);

    // Idempotent: a second run deletes nothing.
    expect(await purgeExpiredProfileViews(conn, { now: NOW })).toEqual({ deleted: 0 });
  });

  it('honors a custom window', async () => {
    insertView('ancient', '2026-01-01T00:00:00.000Z');
    insertView('borderline', '2026-08-01T00:00:00.000Z');
    insertView('today', NOW.toISOString());

    expect(await purgeExpiredProfileViews(conn, { now: NOW, olderThanDays: 30 })).toEqual({
      deleted: 2,
    });
    expect(fixture.sqlite.prepare('SELECT id FROM profile_views').all()).toEqual([{ id: 'today' }]);
  });

  it('rejects nonsense windows instead of deleting everything', async () => {
    await expect(
      purgeExpiredProfileViews(conn, { now: NOW, olderThanDays: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      purgeExpiredProfileViews(conn, { now: NOW, olderThanDays: Number.NaN }),
    ).rejects.toThrow(/positive/);
  });
});
