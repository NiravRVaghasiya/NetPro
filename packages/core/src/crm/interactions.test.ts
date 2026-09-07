import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  countInteractions,
  getContactStats,
  listInteractions,
  logInteraction,
  recomputeContactStats,
  validateInteractionInput,
} from './interactions';
import { getContactTimeline } from './timeline';
import { CrmError, DAY_MS } from './types';

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
      email: `${id}@example.com`,
      company: 'Stripe',
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...extra,
    })
    .run();
}

function contactRow(id: string) {
  return fixture.conn.db
    .select()
    .from(fixture.conn.schema.contacts)
    .where(eq(fixture.conn.schema.contacts.id, id))
    .get();
}

function activityActions(): string[] {
  return fixture.sqlite
    .prepare('SELECT action FROM activity_log ORDER BY rowid')
    .all()
    .map((r) => (r as { action: string }).action);
}

describe('validateInteractionInput', () => {
  it('rejects unknown type, direction, and channel with actionable messages', () => {
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'dm' }, NOW)
    ).toThrowError(/Unknown interaction type "dm"/);
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'note', direction: 'sideways' }, NOW)
    ).toThrowError(/Unknown direction "sideways"/);
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'note', channel: 'telegram' }, NOW)
    ).toThrowError(/Unknown channel "telegram"/);
  });

  it('applies default directions from the type, and null when none applies', () => {
    expect(validateInteractionInput({ contactId: 'c1', type: 'email_sent' }, NOW).direction).toBe(
      'outbound'
    );
    expect(
      validateInteractionInput({ contactId: 'c1', type: 'email_received' }, NOW).direction
    ).toBe('inbound');
    expect(validateInteractionInput({ contactId: 'c1', type: 'note' }, NOW).direction).toBeNull();
    // explicit direction wins over the default
    expect(
      validateInteractionInput({ contactId: 'c1', type: 'linkedin_message', direction: 'inbound' }, NOW)
        .direction
    ).toBe('inbound');
  });

  it('enforces length caps and normalizes blanks to null', () => {
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'note', subject: 'x'.repeat(201) }, NOW)
    ).toThrowError(/"subject" must be 200 characters or fewer/);
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'note', content: 'x'.repeat(5001) }, NOW)
    ).toThrowError(/"content" must be 5000 characters or fewer/);
    const normalized = validateInteractionInput(
      { contactId: 'c1', type: 'note', subject: '  ', content: ' hi ' },
      NOW
    );
    expect(normalized.subject).toBeNull();
    expect(normalized.content).toBe('hi');
  });

  it('bounds occurredAt: +1 day future slack, 10 years backdated, defaults to now', () => {
    expect(
      validateInteractionInput({ contactId: 'c1', type: 'note' }, NOW).occurredAt
    ).toBe(NOW.toISOString());
    expect(() =>
      validateInteractionInput(
        { contactId: 'c1', type: 'note', occurredAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString() },
        NOW
      )
    ).toThrowError(/too far in the future/);
    expect(() =>
      validateInteractionInput(
        { contactId: 'c1', type: 'note', occurredAt: new Date(NOW.getTime() - 11 * 365 * DAY_MS).toISOString() },
        NOW
      )
    ).toThrowError(/too far in the past/);
    expect(() =>
      validateInteractionInput({ contactId: 'c1', type: 'note', occurredAt: 'yesterday' }, NOW)
    ).toThrowError(/not a valid date/);
    // backdating within bounds is the point of the feature
    expect(
      validateInteractionInput(
        { contactId: 'c1', type: 'meeting', occurredAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString() },
        NOW
      ).occurredAt
    ).toBe(new Date(NOW.getTime() - 30 * DAY_MS).toISOString());
  });

  it('requires a contactId', () => {
    expect(() => validateInteractionInput({ contactId: '  ', type: 'note' }, NOW)).toThrowError(
      /contactId is required/
    );
  });
});

describe('logInteraction (real SQLite migrations)', () => {
  it('inserts the interaction and recomputes contact stats', async () => {
    seedContact('c1', 'Jane Doe');
    const result = await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'meeting', channel: 'in_person', content: 'Coffee + collab talk' },
      { now: NOW }
    );

    expect(result.interaction.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.interaction.occurredAt).toBe(NOW.toISOString());
    expect(result.interaction.createdAt).toBe(NOW.toISOString());
    expect(result.contact.fullName).toBe('Jane Doe');

    expect(result.stats).toEqual({
      lastInteraction: NOW.toISOString(),
      interactionCount: 1,
      // recency 40 + frequency 3.75 + depth 0 (no direction) + richness 3.75
      // = 47.5 → rounds to 48 → column 0.48
      relationshipScore: 0.48,
    });

    const row = contactRow('c1')!;
    expect(row.lastInteraction).toBe(NOW.toISOString());
    expect(row.interactionCount).toBe(1);
    expect(row.relationshipScore).toBe(0.48);
    expect(row.updatedAt).toBe(NOW.toISOString());
  });

  it('writes an audit row to activity_log', async () => {
    seedContact('c1', 'Jane Doe');
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'note' }, { now: NOW });
    expect(activityActions()).toEqual(['interaction.logged']);
  });

  it('rejects unknown and soft-deleted contacts with not_found', async () => {
    seedContact('gone', 'Deleted Person', { deletedAt: NOW.toISOString() });
    for (const id of ['missing', 'gone']) {
      await expect(
        logInteraction(fixture.conn, { contactId: id, type: 'note' }, { now: NOW })
      ).rejects.toMatchObject({ name: 'CrmError', code: 'not_found' });
    }
  });

  it('rejects an unknown campaignId with not_found', async () => {
    seedContact('c1', 'Jane Doe');
    await expect(
      logInteraction(
        fixture.conn,
        { contactId: 'c1', type: 'email_sent', campaignId: 'nope' },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never rewinds lastInteraction when a backdated log arrives later', async () => {
    seedContact('c1', 'Jane Doe');
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'call' }, { now: NOW });
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS);
    const result = await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'meeting', occurredAt: tenDaysAgo.toISOString() },
      { now: NOW }
    );
    expect(result.stats.lastInteraction).toBe(NOW.toISOString());
    expect(result.stats.interactionCount).toBe(2);
  });

  it('accumulates history: score reflects frequency, depth, and richness', async () => {
    seedContact('c1', 'Jane Doe');
    const day = DAY_MS;
    await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'email_sent', occurredAt: new Date(NOW.getTime() - 2 * day).toISOString() },
      { now: NOW }
    );
    await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'email_received', occurredAt: new Date(NOW.getTime() - 1 * day).toISOString() },
      { now: NOW }
    );
    const result = await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'meeting', occurredAt: NOW.toISOString() },
      { now: NOW }
    );
    // recency: last is NOW → 40; frequency 3×15×0.25=11.25; depth 1:1 → 20;
    // richness 3×25×0.15=11.25 → 82.5 → 83 → column 0.83
    expect(result.stats.relationshipScore).toBe(0.83);
    expect(result.stats.interactionCount).toBe(3);
  });

  it('recomputeContactStats is idempotent and self-healing', async () => {
    seedContact('c1', 'Jane Doe');
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'note' }, { now: NOW });
    // corrupt the denormalized columns, then recompute
    fixture.sqlite
      .prepare('UPDATE contacts SET interaction_count = 99, relationship_score = 0.1 WHERE id = ?')
      .run('c1');
    const stats = await recomputeContactStats(fixture.conn, 'c1', NOW);
    expect(stats.interactionCount).toBe(1);
    expect(contactRow('c1')!.interactionCount).toBe(1);
  });

  it('links interactions to a campaign when the id exists', async () => {
    seedContact('c1', 'Jane Doe');
    fixture.conn.db
      .insert(fixture.conn.schema.campaigns)
      .values({ id: 'camp1', name: 'Reactivation', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .run();
    const result = await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'email_sent', campaignId: 'camp1' },
      { now: NOW }
    );
    expect(result.interaction.campaignId).toBe('camp1');
  });
});

describe('listInteractions / countInteractions', () => {
  it('returns newest-first history with the contact name, filtered and paginated', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'note', occurredAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString() },
      { now: NOW }
    );
    await logInteraction(
      fixture.conn,
      { contactId: 'c2', type: 'call', occurredAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString() },
      { now: NOW }
    );
    await logInteraction(
      fixture.conn,
      { contactId: 'c1', type: 'meeting', occurredAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString() },
      { now: NOW }
    );

    const all = await listInteractions(fixture.conn);
    expect(all.map((i) => i.type)).toEqual(['meeting', 'call', 'note']);
    expect(all[0]!.contactName).toBe('Jane Doe');
    expect(all[1]!.contactName).toBe('John Smith');

    const jane = await listInteractions(fixture.conn, { contactId: 'c1' });
    expect(jane.map((i) => i.type)).toEqual(['meeting', 'note']);

    const paged = await listInteractions(fixture.conn, { limit: 1, offset: 1 });
    expect(paged.map((i) => i.type)).toEqual(['call']);

    expect(await countInteractions(fixture.conn)).toBe(3);
    expect(await countInteractions(fixture.conn, 'c1')).toBe(2);
  });

  it('hides interactions of soft-deleted contacts', async () => {
    seedContact('c1', 'Jane Doe');
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'note' }, { now: NOW });
    fixture.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), 'c1');
    expect(await listInteractions(fixture.conn)).toEqual([]);
  });
});

describe('getContactStats / getContactTimeline', () => {
  it('returns null timeline for unknown contacts and stats null for missing rows', async () => {
    expect(await getContactTimeline(fixture.conn, 'nope', { now: NOW })).toBeNull();
    expect(await getContactStats(fixture.conn, 'nope')).toBeNull();
  });

  it('aggregates contact, stats, history, and pending follow-ups', async () => {
    seedContact('c1', 'Jane Doe', { company: 'Stripe' });
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'meeting' }, { now: NOW });
    fixture.conn.db
      .insert(fixture.conn.schema.followUps)
      .values({
        id: 'f1',
        contactId: 'c1',
        dueAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
        status: 'pending',
        createdAt: NOW.toISOString(),
      })
      .run();

    const timeline = await getContactTimeline(fixture.conn, 'c1', { now: NOW });
    expect(timeline).not.toBeNull();
    expect(timeline!.contact.fullName).toBe('Jane Doe');
    expect(timeline!.stats.interactionCount).toBe(1);
    expect(timeline!.interactions).toHaveLength(1);
    expect(timeline!.followUps.map((f) => f.id)).toEqual(['f1']);
  });

  it('getContactStats reads the denormalized columns', async () => {
    seedContact('c1', 'Jane Doe');
    await logInteraction(fixture.conn, { contactId: 'c1', type: 'note' }, { now: NOW });
    const stats = await getContactStats(fixture.conn, 'c1');
    expect(stats).toEqual({
      lastInteraction: NOW.toISOString(),
      interactionCount: 1,
      relationshipScore: expect.any(Number),
    });
  });
});

describe('CrmError', () => {
  it('carries a code for HTTP mapping', () => {
    const err = new CrmError('invalid_input', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CrmError');
    expect(err.code).toBe('invalid_input');
  });

  it('logInteraction surfaces validation as CrmError invalid_input', async () => {
    seedContact('c1', 'Jane Doe');
    await expect(
      logInteraction(fixture.conn, { contactId: 'c1', type: 'carrier-pigeon' }, { now: NOW })
    ).rejects.toMatchObject({ name: 'CrmError', code: 'invalid_input' });
  });
});
