import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  executeTrackAdd,
  executeTrackCancel,
  executeTrackDone,
  executeTrackList,
  executeTrackLog,
  executeTrackSnooze,
  followUpDurationMs,
  relativeDay,
  selectedListSection,
  utcDay,
} from './track';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => {
  fixture.sqlite.close();
});

function seedContact(id: string, fullName: string, company = 'Stripe', email?: string) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: email ?? `${id}@example.com`,
      company,
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

describe('flag helpers', () => {
  it('selectedListSection defaults to pending and rejects combinations', () => {
    expect(selectedListSection({})).toBe('pending');
    expect(selectedListSection({ dueToday: true })).toBe('due-today');
    expect(selectedListSection({ recent: true })).toBe('recent');
    expect(selectedListSection({ all: true })).toBe('all');
    expect(() => selectedListSection({ dueToday: true, overdue: true })).toThrowError(
      /mutually exclusive/
    );
  });

  it('followUpDurationMs handles the optional-value flag shape', () => {
    expect(followUpDurationMs(undefined)).toBeNull();
    expect(followUpDurationMs(true)).toBe(7 * DAY); // bare --follow-up → 7d
    expect(followUpDurationMs('24h')).toBe(DAY);
    expect(followUpDurationMs('2w')).toBe(14 * DAY);
    expect(() => followUpDurationMs('soon')).toThrowError(/Invalid duration "soon"/);
  });

  it('relativeDay renders human offsets in UTC days', () => {
    expect(relativeDay(NOW.toISOString(), NOW)).toBe('today');
    expect(relativeDay(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe('tomorrow');
    expect(relativeDay(new Date(NOW.getTime() - DAY).toISOString(), NOW)).toBe('yesterday');
    expect(relativeDay(new Date(NOW.getTime() + 3 * DAY).toISOString(), NOW)).toBe('in 3d');
    expect(relativeDay(new Date(NOW.getTime() - 9 * DAY).toISOString(), NOW)).toBe('9d ago');
    expect(utcDay('2026-09-13T09:00:00Z')).toBe('2026-09-13');
  });
});

describe('netpro track log', () => {
  it('logs an interaction and reports the recomputed score', async () => {
    seedContact('c1', 'Jane Doe');
    const out = await executeTrackLog(
      'Jane Doe',
      { type: 'note', note: 'Discussed collab on OSS project' },
      fixture.conn,
      NOW
    );
    expect(out).toContain('✓ Logged note with Jane Doe');
    // note has no direction: 40 recency + 3.75 frequency + 3.75 richness = 47.5 → 48
    expect(out).toContain('score 0.48');
    expect(out).toContain('1 interaction.');

    const rows = fixture.sqlite
      .prepare('SELECT type, content FROM interactions')
      .all() as Array<{ type: string; content: string }>;
    expect(rows).toEqual([{ type: 'note', content: 'Discussed collab on OSS project' }]);
  });

  it('--follow-up creates the interaction and the reminder together', async () => {
    seedContact('c1', 'Jane Doe', 'Stripe', 'jane@example.com');
    const out = await executeTrackLog(
      'jane@example.com',
      { type: 'call', followUp: '7d', reason: 'Send recap' },
      fixture.conn,
      NOW
    );
    expect(out).toContain('✓ Logged call with Jane Doe');
    expect(out).toContain('Follow-up due 2026-09-13 (in 7d)');
    expect(out).toContain('"Send recap"');
    const followUps = fixture.sqlite.prepare('SELECT reason FROM follow_ups').all();
    expect(followUps).toEqual([{ reason: 'Send recap' }]);
  });

  it('bare --follow-up defaults to 7d', async () => {
    seedContact('c1', 'Jane Doe');
    const out = await executeTrackLog('c1', { followUp: true }, fixture.conn, NOW);
    expect(out).toContain('Follow-up due 2026-09-13');
  });

  it('rejects unknown contacts, ambiguous names, and bad types with actionable errors', async () => {
    seedContact('c1', 'Jane Doe', 'Stripe', 'jane@stripe.com');
    seedContact('c2', 'Jane Doe', 'Acme', 'jane@acme.com');
    await expect(
      executeTrackLog('Nobody Here', { note: 'hi' }, fixture.conn, NOW)
    ).rejects.toThrowError(/No contact matches "Nobody Here"/);
    await expect(executeTrackLog('Jane Doe', {}, fixture.conn, NOW)).rejects.toThrowError(
      /Ambiguous contact "Jane Doe"/
    );
    await expect(
      executeTrackLog('jane@stripe.com', { type: 'telepathy' }, fixture.conn, NOW)
    ).rejects.toThrowError(/Unknown interaction type "telepathy"/);
  });

  it('--json prints a machine-readable result', async () => {
    seedContact('c1', 'Jane Doe');
    const out = await executeTrackLog('c1', { json: true }, fixture.conn, NOW);
    const parsed = JSON.parse(out) as {
      interaction: { type: string };
      stats: { interactionCount: number };
      followUp: unknown;
    };
    expect(parsed.interaction.type).toBe('note');
    expect(parsed.stats.interactionCount).toBe(1);
    expect(parsed.followUp).toBeNull();
  });

  it('backdated logs mention the date and keep lastInteraction at max', async () => {
    seedContact('c1', 'Jane Doe');
    await executeTrackLog('c1', { type: 'meeting' }, fixture.conn, NOW);
    const out = await executeTrackLog(
      'c1',
      { type: 'call', at: new Date(NOW.getTime() - 10 * DAY).toISOString() },
      fixture.conn,
      NOW
    );
    expect(out).toContain('on 2026-08-27');
    const row = fixture.sqlite
      .prepare('SELECT last_interaction AS last, interaction_count AS n FROM contacts')
      .get() as { last: string; n: number };
    expect(row.last).toBe(NOW.toISOString());
    expect(row.n).toBe(2);
  });
});

describe('netpro track add', () => {
  it('logs a meeting with the met-at context and schedules the follow-up', async () => {
    seedContact('c1', 'Jane Doe');
    const out = await executeTrackAdd(
      'Jane Doe',
      { metAt: 'React Conf', followUp: '7d' },
      fixture.conn,
      NOW
    );
    expect(out).toContain('✓ Met Jane Doe — "React Conf" logged as a meeting.');
    expect(out).toContain('Follow-up due 2026-09-13 (in 7d)');
    expect(out).toContain('"Follow up from React Conf"');

    const interaction = fixture.sqlite
      .prepare('SELECT type, channel, content FROM interactions')
      .get() as { type: string; channel: string; content: string };
    expect(interaction).toEqual({ type: 'meeting', channel: 'in_person', content: 'React Conf' });
  });

  it('requires --met-at and notes when no follow-up was scheduled', async () => {
    seedContact('c1', 'Jane Doe');
    await expect(executeTrackAdd('Jane Doe', {}, fixture.conn, NOW)).rejects.toThrowError(
      /--met-at is required/
    );
    const out = await executeTrackAdd('Jane Doe', { metAt: 'OSS meetup' }, fixture.conn, NOW);
    expect(out).toContain('No follow-up scheduled');
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM follow_ups').get()).toEqual({ n: 0 });
  });
});

describe('netpro track list', () => {
  async function seedFollowUps() {
    seedContact('c1', 'Jane Doe', 'Stripe', 'jane@stripe.com');
    seedContact('c2', 'John Smith', 'Acme');
    await executeTrackLog(
      'jane@stripe.com',
      { type: 'meeting', followUp: '1d', reason: 'Old promise' },
      fixture.conn,
      new Date(NOW.getTime() - 2 * DAY)
    ); // due yesterday 12:00 UTC → overdue
    await executeTrackAdd('John Smith', { metAt: 'Next.js Conf', followUp: '6h' }, fixture.conn, NOW); // due today 18:00 UTC
    await executeTrackLog(
      'c1',
      { followUp: '10d', at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() },
      fixture.conn,
      NOW
    ); // upcoming, logged an hour ago (deterministic --recent ordering)
  }

  it('defaults to pending with counts, sorted by effective due', async () => {
    await seedFollowUps();
    const out = await executeTrackList({}, fixture.conn, NOW);
    expect(out).toContain('Pending follow-ups (3):');
    expect(out).toContain('Follow-ups — 1 overdue · 1 due today · 1 upcoming');
    expect(out).toContain('⚠ Jane Doe (Stripe)');
    expect(out).toContain('netpro track done <id>');
    // overdue first, then today, then upcoming
    const janeOld = out.indexOf('Old promise');
    const john = out.indexOf('John Smith');
    const upcoming = out.lastIndexOf('Jane Doe');
    expect(janeOld).toBeLessThan(john);
    expect(john).toBeLessThan(upcoming);
  });

  it('--due-today filters and celebrates empty days', async () => {
    await seedFollowUps();
    const out = await executeTrackList({ dueToday: true }, fixture.conn, NOW);
    expect(out).toContain('Follow-ups — due-today (1):');
    expect(out).toContain('John Smith');
    expect(out).not.toContain('Old promise');

    const quiet = await executeTrackList({ dueToday: true, contact: 'jane@stripe.com' }, fixture.conn, NOW);
    expect(quiet).toContain('Nothing due today. 🎉');
  });

  it('--recent lists interactions newest-first with contact names', async () => {
    await seedFollowUps();
    const out = await executeTrackList({ recent: true }, fixture.conn, NOW);
    expect(out).toContain('Recent interactions (3):');
    const lines = out.split('\n').slice(1);
    expect(lines[0]).toContain('meeting');
    expect(lines[0]).toContain('John Smith');
    expect(lines[0]).toContain('"Next.js Conf"');
    expect(lines[1]).toContain('note');
    expect(lines[1]).toContain('Jane Doe');
    expect(lines[2]).toContain('2026-09-04');
    expect(lines[2]).toContain('meeting');
    expect(lines[2]).toContain('Jane Doe');
  });

  it('empty states point at the right command', async () => {
    const followUps = await executeTrackList({}, fixture.conn, NOW);
    expect(followUps).toContain('netpro track add "Jane Doe" --met-at "React Conf"');
    const recent = await executeTrackList({ recent: true }, fixture.conn, NOW);
    expect(recent).toContain('netpro track log "Jane Doe" --note');
  });

  it('--contact resolves selectors and rejects ambiguous ones', async () => {
    await seedFollowUps();
    const out = await executeTrackList({ contact: 'John Smith' }, fixture.conn, NOW);
    expect(out).toContain('John Smith');
    expect(out).not.toContain('Old promise');
    seedContact('c3', 'John Smith', 'Netlify');
    await expect(executeTrackList({ contact: 'John Smith' }, fixture.conn, NOW)).rejects.toThrowError(
      /Ambiguous contact/
    );
  });

  it('--json prints counts and rows', async () => {
    await seedFollowUps();
    const parsed = JSON.parse(await executeTrackList({ json: true }, fixture.conn, NOW)) as {
      followUps: unknown[];
      counts: { overdue: number; dueToday: number; upcoming: number; pending: number };
    };
    expect(parsed.followUps).toHaveLength(3);
    expect(parsed.counts).toEqual({ overdue: 1, dueToday: 1, upcoming: 1, pending: 3 });
  });

  it('rejects combining sections and bad limits', async () => {
    await expect(executeTrackList({ dueToday: true, recent: true }, fixture.conn, NOW)).rejects.toThrowError(
      /mutually exclusive/
    );
    await expect(executeTrackList({ limit: 'soon' }, fixture.conn, NOW)).rejects.toThrowError(
      /--limit must be a positive number/
    );
  });
});

describe('netpro track done / snooze / cancel', () => {
  async function seedOne(): Promise<string> {
    seedContact('c1', 'Jane Doe');
    await executeTrackLog('c1', { followUp: '7d', reason: 'Send deck' }, fixture.conn, NOW);
    const row = fixture.sqlite.prepare('SELECT id FROM follow_ups').get() as { id: string };
    return row.id;
  }

  it('done completes by full id or unique prefix and reports recurrence', async () => {
    const id = await seedOne();
    const out = await executeTrackDone(id.slice(0, 8), {}, fixture.conn, NOW);
    expect(out).toContain('✓ Completed follow-up for Jane Doe.');
    expect(fixture.sqlite.prepare("SELECT status FROM follow_ups WHERE id = ?").get(id)).toEqual({
      status: 'completed',
    });
  });

  it('done re-arms recurring follow-ups', async () => {
    seedContact('c1', 'Jane Doe');
    await executeTrackLog('c1', { followUp: '7d' }, fixture.conn, NOW);
    fixture.sqlite.prepare("UPDATE follow_ups SET recurring = 1, recurrence_rule = '30d'").run();
    const id = (fixture.sqlite.prepare('SELECT id FROM follow_ups').get() as { id: string }).id;
    const out = await executeTrackDone(id, {}, fixture.conn, NOW);
    expect(out).toContain('Recurring — next due 2026-10-06 (in 30d)');
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM follow_ups').get()).toEqual({ n: 2 });
  });

  it('done rejects unknown ids', async () => {
    await seedOne();
    await expect(executeTrackDone('deadbeef', {}, fixture.conn, NOW)).rejects.toThrowError(
      /No pending follow-up matches "deadbeef"/
    );
  });

  it('snooze --for pushes the effective due date', async () => {
    const id = await seedOne();
    const out = await executeTrackSnooze(id, { for: '30d' }, fixture.conn, NOW);
    expect(out).toContain('⏸ Snoozed');
    expect(out).toContain('until 2026-10-06 (in 30d)');
    const list = await executeTrackList({ overdue: true }, fixture.conn, NOW);
    expect(list).toContain('No follow-ups here.');
  });

  it('snooze --until accepts bare dates as 09:00 UTC', async () => {
    const id = await seedOne();
    const out = await executeTrackSnooze(id, { until: '2026-10-01' }, fixture.conn, NOW);
    expect(out).toContain('until 2026-10-01');
    const row = fixture.sqlite
      .prepare('SELECT snoozed_until AS s FROM follow_ups WHERE id = ?')
      .get(id) as { s: string };
    expect(row.s).toBe('2026-10-01T09:00:00.000Z');
  });

  it('snooze requires a target', async () => {
    const id = await seedOne();
    await expect(executeTrackSnooze(id, {}, fixture.conn, NOW)).rejects.toThrowError(
      /--for 3d \(relative\) or --until/
    );
  });

  it('cancel closes a follow-up without completing it', async () => {
    const id = await seedOne();
    const out = await executeTrackCancel(id, {}, fixture.conn, NOW);
    expect(out).toContain('✗ Cancelled follow-up for Jane Doe');
    expect(fixture.sqlite.prepare('SELECT status FROM follow_ups WHERE id = ?').get(id)).toEqual({
      status: 'cancelled',
    });
  });

  it('prefix ambiguity errors and lists candidates', async () => {
    seedContact('c1', 'Jane Doe');
    fixture.conn.db
      .insert(fixture.conn.schema.followUps)
      .values([
        { id: 'aaaa1111-0000-0000-0000-000000000000', contactId: 'c1', dueAt: NOW.toISOString(), status: 'pending', createdAt: NOW.toISOString() },
        { id: 'aaaa2222-0000-0000-0000-000000000000', contactId: 'c1', dueAt: NOW.toISOString(), status: 'pending', createdAt: NOW.toISOString() },
      ])
      .run();
    await expect(executeTrackDone('aaaa', {}, fixture.conn, NOW)).rejects.toThrowError(
      /ambiguous — 2 pending follow-ups match: aaaa1111-0000-0000-0000-000000000000, aaaa2222/
    );
  });
});
