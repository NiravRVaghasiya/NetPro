import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { POST } from './route';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: 'a',
      fullName: 'Ada Lovelace',
      email: 'ada@engines.dev',
      source: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
});
afterAll(() => fixture.sqlite.close());

async function eventWithUnmatched(): Promise<string> {
  const { importEvents } = await import('@netpro/core/src/events');
  await importEvents(fixture.conn, {
    csv: 'name,attendees\nReact Conf,nobody@nowhere.dev',
    now: new Date(NOW),
  });
  const { resolveEventRef } = await import('@netpro/core/src/events');
  return (await resolveEventRef(fixture.conn, 'React Conf')).id;
}

async function addNova(): Promise<void> {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: 'n',
      fullName: 'Nova Nowhere',
      email: 'nobody@nowhere.dev',
      source: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://localhost/api/events/${id}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

interface MatchBody {
  matched: number;
  linked: number;
  duplicates: number;
  remaining: unknown[];
  applied: boolean;
  event: { id: string; name: string };
}

describe('POST /api/events/[id]/match', () => {
  it('previews by default and links only when apply is true', async () => {
    const id = await eventWithUnmatched();
    await addNova();

    const preview = (await (await post(id, {})).json()) as MatchBody;
    expect(preview.matched).toBe(1);
    expect(preview.linked).toBe(0);
    expect(preview.applied).toBe(false);

    const applied = (await (await post(id, { apply: true })).json()) as MatchBody;
    expect(applied.linked).toBe(1);
    expect(applied.applied).toBe(true);

    // The bucket is emptied by a successful apply, so a repeat run has
    // nothing left to consider — re-matching is idempotent by construction.
    const again = (await (await post(id, { apply: true })).json()) as MatchBody;
    expect(again.matched).toBe(0);
    expect(again.linked).toBe(0);
  });

  it('resolves the event by name too', async () => {
    const id = await eventWithUnmatched();
    await addNova();
    const body = (await (await post('React Conf', { apply: true })).json()) as MatchBody;
    expect(body.event.id).toBe(id);
    expect(body.linked).toBe(1);
  });

  it('leaves genuinely unknown lines in the bucket', async () => {
    const id = await eventWithUnmatched();
    const body = (await (await post(id, { apply: true })).json()) as MatchBody;
    expect(body.matched).toBe(0);
    expect(body.remaining).toHaveLength(1);
  });

  it('404s an unknown event and 400s an ambiguous one', async () => {
    expect((await post('nope', {})).status).toBe(404);

    const { upsertEvent } = await import('@netpro/core/src/events');
    await upsertEvent(fixture.conn, { name: 'Twin' }, { now: new Date(NOW) });
    fixture.conn.db
      .insert(fixture.conn.schema.events)
      .values({ id: 'twin-2', name: 'twin', source: 'import', createdAt: NOW })
      .run();
    const res = await post('Twin', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Ambiguous');
  });
});
