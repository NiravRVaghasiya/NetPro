import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { listCrmContacts } from './contacts';
import { logInteraction } from './interactions';
import { createFollowUp, snoozeFollowUp } from './follow-ups';
import { DAY_MS } from './types';

const NOW = new Date('2026-09-06T12:00:00Z');

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => {
  fixture.sqlite.close();
});

function seedContact(id: string, fullName: string, extra: Record<string, unknown> = {}) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...extra,
    })
    .run();
}

describe('listCrmContacts', () => {
  it('returns stats columns with defaults for a fresh network', async () => {
    seedContact('c1', 'Jane Doe', { company: 'Stripe', relationshipScore: 0 });
    const page = await listCrmContacts(fixture.conn);
    expect(page.total).toBe(1);
    expect(page.contacts[0]).toMatchObject({
      id: 'c1',
      fullName: 'Jane Doe',
      company: 'Stripe',
      lastInteraction: null,
      interactionCount: 0,
      nextFollowUpAt: null,
    });
    expect(page.sort).toBe('recent');
  });

  it('excludes soft-deleted contacts', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'Gone Person', { deletedAt: NOW.toISOString() });
    const page = await listCrmContacts(fixture.conn);
    expect(page.total).toBe(1);
    expect(page.contacts.map((c) => c.id)).toEqual(['c1']);
  });

  it('sorts recent by last interaction with nulls last, and score/name behave', async () => {
    seedContact('a', 'Alice Never');
    seedContact('b', 'Bob Recent', { relationshipScore: 0.2 });
    seedContact('c', 'Cara Mid', {
      relationshipScore: 0.9,
      lastInteraction: new Date(NOW.getTime() - 5 * DAY_MS).toISOString(),
    });
    await logInteraction(
      fixture.conn,
      {
        contactId: 'b',
        type: 'call',
        occurredAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
      },
      { now: NOW }
    );

    const recent = await listCrmContacts(fixture.conn, { sort: 'recent' });
    expect(recent.contacts.map((c) => c.id)).toEqual(['b', 'c', 'a']);

    const byScore = await listCrmContacts(fixture.conn, { sort: 'score' });
    expect(byScore.contacts.map((c) => c.id)).toEqual(['c', 'b', 'a']);

    const byName = await listCrmContacts(fixture.conn, { sort: 'name' });
    expect(byName.contacts.map((c) => c.id)).toEqual(['a', 'b', 'c']);

    // unknown sort falls back to recent
    const fallback = await listCrmContacts(fixture.conn, { sort: 'bogus' as never });
    expect(fallback.sort).toBe('recent');
  });

  it('surfaces the soonest pending follow-up, honoring snoozes and skipping closed ones', async () => {
    seedContact('c1', 'Jane Doe');
    const soon = await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: 2 * DAY_MS }, { now: NOW });
    await createFollowUp(fixture.conn, { contactId: 'c1', dueInMs: 10 * DAY_MS }, { now: NOW });
    const closed = await createFollowUp(
      fixture.conn,
      { contactId: 'c1', dueInMs: DAY_MS },
      { now: NOW }
    );
    fixture.sqlite
      .prepare("UPDATE follow_ups SET status = 'completed' WHERE id = ?")
      .run(closed.id);

    let page = await listCrmContacts(fixture.conn);
    expect(page.contacts[0]!.nextFollowUpAt).toBe(soon.effectiveDueAt);

    // snoozing the soonest one past the other promotes the other
    await snoozeFollowUp(fixture.conn, soon.id, { forMs: 20 * DAY_MS }, { now: NOW });
    page = await listCrmContacts(fixture.conn);
    expect(page.contacts[0]!.nextFollowUpAt).toBe(
      new Date(NOW.getTime() + 10 * DAY_MS).toISOString()
    );

    // follow-up sort puts contacts with pending follow-ups first
    seedContact('c2', 'No Followups');
    const sorted = await listCrmContacts(fixture.conn, { sort: 'follow-up' });
    expect(sorted.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('paginates with limit/offset and clamps bounds', async () => {
    for (let i = 0; i < 5; i++) seedContact(`c${i}`, `Person ${i}`);
    const page = await listCrmContacts(fixture.conn, { limit: 2, offset: 2, sort: 'name' });
    expect(page.contacts.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(page.total).toBe(5);

    const clamped = await listCrmContacts(fixture.conn, { limit: 10_000, offset: -3 });
    expect(clamped.limit).toBe(100);
    expect(clamped.offset).toBe(0);
  });
});
