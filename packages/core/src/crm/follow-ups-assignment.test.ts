// v3.0 Phase 3 — assignment compat and filtering
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { createFollowUp, listFollowUps, assignFollowUp, unassignFollowUpsForUser } from './follow-ups';

const NOW = new Date('2026-09-06T12:00:00Z');
let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => fixture.sqlite.close());

function seedContact(id: string) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName: `Contact ${id}`,
      source: 'test',
      workspaceId: 'default',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

describe('follow-up assignment (Phase 3)', () => {
  it('creates unassigned by default (single-workspace compat)', async () => {
    seedContact('c1');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000, reason: 'call back' },
      { now: NOW }
    );
    expect(row.assignedTo).toBeNull();
    // list without filters still returns it — behaves like v2.5
    const summary = await listFollowUps(fixture.conn, { now: NOW });
    expect(summary.followUps.map((f) => f.id)).toContain(row.id);
  });

  it('assignedTo filter and unassigned filter are mutually exclusive in effect but both work', async () => {
    seedContact('c1');
    const a = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000, assignedTo: 'user-1' },
      { now: NOW }
    );
    const b = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000 * 2 },
      { now: NOW }
    );
    const assigned = await listFollowUps(fixture.conn, { assignedTo: 'user-1', now: NOW });
    expect(assigned.followUps.map((f) => f.id)).toEqual([a.id]);

    const unassigned = await listFollowUps(fixture.conn, { unassigned: true, now: NOW });
    expect(unassigned.followUps.map((f) => f.id)).toEqual([b.id]);

    const me = await listFollowUps(fixture.conn, { assignedToMe: 'user-1', now: NOW });
    expect(me.followUps.map((f) => f.id)).toEqual([a.id]);
  });

  it('assign and unassign flip status and write audit', async () => {
    seedContact('c1');
    const row = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000 },
      { now: NOW }
    );
    const assigned = await assignFollowUp(fixture.conn, row.id, 'user-99', { now: NOW });
    expect(assigned.assignedTo).toBe('user-99');

    const unassigned = await assignFollowUp(fixture.conn, row.id, null, { now: NOW });
    expect(unassigned.assignedTo).toBeNull();

    const actions = fixture.sqlite
      .prepare('SELECT action FROM activity_log ORDER BY rowid')
      .all()
      .map((r) => (r as { action: string }).action);
    expect(actions).toContain('followup.assigned');
  });

  it('unassignFollowUpsForUser only touches pending', async () => {
    seedContact('c1');
    const pending = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000, assignedTo: 'user-x' },
      { now: NOW }
    );
    const { cancelFollowUp } = await import('./follow-ups');
    const completed = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: 86_400_000, assignedTo: 'user-x' },
      { now: NOW }
    );
    await cancelFollowUp(fixture.conn, completed.id, { now: NOW });

    const count = await unassignFollowUpsForUser(fixture.conn, 'user-x');
    expect(count).toBe(1);

    const list = await listFollowUps(fixture.conn, { assignedTo: 'user-x', now: NOW });
    expect(list.followUps).toHaveLength(0);
    const unassigned = await listFollowUps(fixture.conn, { unassigned: true, now: NOW });
    // pending now unassigned, cancelled still assigned but not in pending view
    expect(unassigned.followUps.map((f) => f.id)).toContain(pending.id);
  });

  it('single-workspace single-member: unassigned filter still returns data, assignedToMe with no user returns empty', async () => {
    seedContact('c1');
    await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: 86_400_000 }, { now: NOW });
    const all = await listFollowUps(fixture.conn, { now: NOW });
    expect(all.counts.pending).toBe(1);
    const un = await listFollowUps(fixture.conn, { unassigned: true, now: NOW });
    expect(un.counts.pending).toBe(1);
    const me = await listFollowUps(fixture.conn, { assignedToMe: 'nonexistent', now: NOW });
    expect(me.counts.pending).toBe(0);
  });
});
