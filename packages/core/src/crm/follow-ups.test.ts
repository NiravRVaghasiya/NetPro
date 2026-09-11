import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  effectiveDueAt,
  getFollowUp,
  listFollowUps,
  snoozeFollowUp,
} from './follow-ups';
import { DAY_MS } from './types';

const NOW = new Date('2026-09-06T12:00:00Z');

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => {
  fixture.sqlite.close();
});

function seedContact(id: string, fullName: string, company: string | null = 'Stripe') {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      company,
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

function activityActions(): string[] {
  return fixture.sqlite
    .prepare('SELECT action FROM activity_log ORDER BY rowid')
    .all()
    .map((r) => (r as { action: string }).action);
}

describe('createFollowUp', () => {
  it('creates from a relative due window with contact name joined', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 7 * DAY_MS, reason: 'Send the deck' },
      { now: NOW }
    );
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.dueAt).toBe(new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
    expect(row.effectiveDueAt).toBe(row.dueAt);
    expect(row.status).toBe('pending');
    expect(row.recurring).toBe(false);
    expect(row.contactName).toBe('Jane Doe');
    expect(row.contactCompany).toBe('Stripe');
    expect(activityActions()).toEqual(['followup.created']);
  });

  it('accepts an absolute dueAt (string or Date), including past dates (instantly overdue)', async () => {
    seedContact('c1', 'Jane Doe');
    const past = new Date(NOW.getTime() - DAY_MS);
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueAt: past },
      { now: NOW }
    );
    expect(row.dueAt).toBe(past.toISOString());
    const summary = await listFollowUps(fixture.conn, { view: 'overdue', now: NOW });
    expect(summary.followUps.map((f) => f.id)).toEqual([row.id]);
  });

  it('validates: due target required, unknown contact, bad rule, long reason', async () => {
    seedContact('c1', 'Jane Doe');
    await expect(createFollowUp(fixture.conn, { contactId: 'c1' }, { now: NOW })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      createFollowUp(fixture.conn, { contactId: 'nope', dueInMs: DAY_MS }, { now: NOW })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createFollowUp(
        fixture.conn,
        { contactId: 'c1', dueInMs: DAY_MS, recurrenceRule: 'monthly-ish' },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      createFollowUp(
        fixture.conn,
        { contactId: 'c1', dueInMs: DAY_MS, reason: 'x'.repeat(501) },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: 0 }, { now: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('marks recurring when a valid rule is present', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 30 * DAY_MS, recurrenceRule: '30d', reason: 'Monthly ping' },
      { now: NOW }
    );
    expect(row.recurring).toBe(true);
    expect(row.recurrenceRule).toBe('30d');
  });
});

describe('listFollowUps views and counts', () => {
  async function seedBuckets() {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith', 'Acme');
    const overdue = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueAt: new Date(NOW.getTime() - DAY_MS), reason: 'Old promise' },
      { now: NOW }
    );
    const dueToday = await createFollowUp(
      fixture.conn,
      { contactId: 'c2', dueAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) },
      { now: NOW }
    );
    const upcoming = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 10 * DAY_MS },
      { now: NOW }
    );
    const snoozed = await createFollowUp(
      fixture.conn,
      { contactId: 'c2', dueAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { now: NOW }
    );
    await snoozeFollowUp(fixture.conn, snoozed.id, { forMs: 3 * DAY_MS }, { now: NOW });
    return { overdue, dueToday, upcoming, snoozed };
  }

  it('buckets by UTC day: overdue, due-today, upcoming; snooze moves the effective due', async () => {
    const seeded = await seedBuckets();
    const summary = await listFollowUps(fixture.conn, { now: NOW });
    expect(summary.counts).toEqual({ overdue: 1, dueToday: 1, upcoming: 2, pending: 4 });
    // sorted by effective due ascending: overdue first, snoozed (now +3d) before upcoming (+10d)
    expect(summary.followUps.map((f) => f.id)).toEqual([
      seeded.overdue.id,
      seeded.dueToday.id,
      seeded.snoozed.id,
      seeded.upcoming.id,
    ]);

    expect((await listFollowUps(fixture.conn, { view: 'overdue', now: NOW })).followUps.map((f) => f.id)).toEqual([seeded.overdue.id]);
    expect((await listFollowUps(fixture.conn, { view: 'due-today', now: NOW })).followUps.map((f) => f.id)).toEqual([seeded.dueToday.id]);
    expect((await listFollowUps(fixture.conn, { view: 'upcoming', now: NOW })).followUps.map((f) => f.id)).toEqual([seeded.snoozed.id, seeded.upcoming.id]);
  });

  it('filters by contact and computes counts on the filtered set', async () => {
    await seedBuckets();
    const jane = await listFollowUps(fixture.conn, { contactId: 'c1', now: NOW });
    expect(jane.counts).toEqual({ overdue: 1, dueToday: 0, upcoming: 1, pending: 2 });
    expect(jane.followUps).toHaveLength(2);
  });

  it('completed/cancelled views list closed follow-ups; pending excludes them', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    await completeFollowUp(fixture.conn, row.id, { now: NOW });
    expect((await listFollowUps(fixture.conn, { now: NOW })).counts.pending).toBe(0);
    const completed = await listFollowUps(fixture.conn, { view: 'completed', now: NOW });
    expect(completed.followUps.map((f) => f.id)).toEqual([row.id]);
    expect(completed.followUps[0]!.completedAt).toBe(NOW.toISOString());
  });

  it('hides follow-ups of soft-deleted contacts', async () => {
    seedContact('c1', 'Jane Doe');
    await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    fixture.sqlite
      .prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?')
      .run(NOW.toISOString(), 'c1');
    const summary = await listFollowUps(fixture.conn, { now: NOW });
    expect(summary.followUps).toEqual([]);
    expect(summary.counts.pending).toBe(0);
  });

  it('respects the limit', async () => {
    seedContact('c1', 'Jane Doe');
    for (let i = 0; i < 5; i++) {
      await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: (i + 1) * DAY_MS }, { now: NOW });
    }
    const summary = await listFollowUps(fixture.conn, { limit: 2, now: NOW });
    expect(summary.followUps).toHaveLength(2);
    expect(summary.counts.pending).toBe(5); // counts are not limited
  });
});

describe('completeFollowUp', () => {
  it('completes a pending follow-up', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    const result = await completeFollowUp(fixture.conn, row.id, { now: NOW });
    expect(result.completed.status).toBe('completed');
    expect(result.completed.completedAt).toBe(NOW.toISOString());
    expect(result.next).toBeNull();
    expect(await getFollowUp(fixture.conn, row.id)).toMatchObject({ status: 'completed' });
    expect(activityActions()).toContain('followup.completed');
  });

  it('re-arms recurring follow-ups one interval after completion', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: DAY_MS, recurrenceRule: '30d', reason: 'Monthly ping' },
      { now: NOW }
    );
    const late = new Date(NOW.getTime() + 5 * DAY_MS); // completed 5 days late
    const result = await completeFollowUp(fixture.conn, row.id, { now: late });
    expect(result.next).not.toBeNull();
    expect(result.next!.dueAt).toBe(new Date(late.getTime() + 30 * DAY_MS).toISOString());
    expect(result.next!.recurring).toBe(true);
    expect(result.next!.reason).toBe('Monthly ping');
    const summary = await listFollowUps(fixture.conn, { now: late });
    expect(summary.counts.pending).toBe(1);
  });

  it('tolerates a corrupted recurrence rule: completes without re-arming', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: DAY_MS, recurrenceRule: '7d' },
      { now: NOW }
    );
    fixture.sqlite
      .prepare('UPDATE follow_ups SET recurrence_rule = ? WHERE id = ?')
      .run('every full moon', row.id);
    const result = await completeFollowUp(fixture.conn, row.id, { now: NOW });
    expect(result.completed.status).toBe('completed');
    expect(result.next).toBeNull();
  });

  it('rejects unknown ids and double-completion', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    await completeFollowUp(fixture.conn, row.id, { now: NOW });
    await expect(completeFollowUp(fixture.conn, row.id, { now: NOW })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(completeFollowUp(fixture.conn, 'missing', { now: NOW })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('snoozeFollowUp / cancelFollowUp', () => {
  it('snoozes relatively and absolutely; effective due moves only forward', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueAt: new Date(NOW.getTime() + 10 * DAY_MS) },
      { now: NOW }
    );
    const snoozed = await snoozeFollowUp(fixture.conn, row.id, { forMs: 30 * DAY_MS }, { now: NOW });
    expect(snoozed.snoozedUntil).toBe(new Date(NOW.getTime() + 30 * DAY_MS).toISOString());
    expect(snoozed.effectiveDueAt).toBe(snoozed.snoozedUntil);

    // snoozing to *before* the original due date keeps the original due
    expect(effectiveDueAt(row.dueAt, new Date(NOW.getTime() + 2 * DAY_MS).toISOString())).toBe(
      row.dueAt
    );

    const until = new Date(NOW.getTime() + 60 * DAY_MS).toISOString();
    const absolute = await snoozeFollowUp(fixture.conn, row.id, { untilIso: until }, { now: NOW });
    expect(absolute.snoozedUntil).toBe(until);
    expect(activityActions()).toContain('followup.snoozed');
  });

  it('rejects past snooze targets, missing input, and non-pending rows', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    await expect(
      snoozeFollowUp(
        fixture.conn,
        row.id,
        { untilIso: new Date(NOW.getTime() - 1000).toISOString() },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(snoozeFollowUp(fixture.conn, row.id, {}, { now: NOW })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await cancelFollowUp(fixture.conn, row.id, { now: NOW });
    await expect(
      snoozeFollowUp(fixture.conn, row.id, { forMs: DAY_MS }, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cancels: status flips, pending lists drop it, audit row written', async () => {
    seedContact('c1', 'Jane Doe');
    const row = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: DAY_MS }, { now: NOW });
    const cancelled = await cancelFollowUp(fixture.conn, row.id, { now: NOW });
    expect(cancelled.status).toBe('cancelled');
    expect((await listFollowUps(fixture.conn, { now: NOW })).counts.pending).toBe(0);
    expect((await listFollowUps(fixture.conn, { view: 'cancelled', now: NOW })).followUps.map((f) => f.id)).toEqual([row.id]);
    expect(activityActions()).toContain('followup.cancelled');
  });

  it('getFollowUp returns null for unknown ids', async () => {
    expect(await getFollowUp(fixture.conn, 'missing')).toBeNull();
  });
});
