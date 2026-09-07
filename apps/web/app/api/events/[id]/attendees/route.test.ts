import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { DELETE, POST } from './route';
import { listEdges } from '@netpro/core/src/graph';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  for (const r of [
    { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', relationshipScore: 0.6 },
    { id: 'gone', fullName: 'Ghost', email: 'ghost@example.com', deletedAt: NOW },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

async function eventId(): Promise<string> {
  const { upsertEvent } = await import('@netpro/core/src/events');
  const { event } = await upsertEvent(fixture.conn, { name: 'React Conf' }, { now: new Date(NOW) });
  return event.id;
}

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://localhost/api/events/${id}/attendees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

const del = (id: string, qs: string) =>
  DELETE(new Request(`http://localhost/api/events/${id}/attendees${qs}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

interface LinkBody {
  created: boolean;
  edgesCreated: number;
  contact: { id: string; fullName: string };
}

describe('POST /api/events/[id]/attendees', () => {
  it('links a contact by id, by email or by name', async () => {
    const id = await eventId();
    const byId = (await (await post(id, { contactId: 'a' })).json()) as LinkBody;
    expect(byId.created).toBe(true);
    expect(byId.contact.fullName).toBe('Ada Lovelace');
  });

  it('links a second attendee with a confirmed met_at_event edge', async () => {
    const id = await eventId();
    await post(id, { contact: 'ada@engines.dev' });
    const res = await post(id, { contact: 'Bob Builder', role: 'speaker' });
    const body = (await res.json()) as LinkBody;
    expect(body.edgesCreated).toBe(1);
    const edges = await listEdges(fixture.conn, { relation: 'met_at_event' });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ status: 'confirmed', confidence: 1 });
  });

  it('is idempotent — a repeat link reports created: false', async () => {
    const id = await eventId();
    await post(id, { contactId: 'a' });
    const body = (await (await post(id, { contactId: 'a' })).json()) as LinkBody;
    expect(body.created).toBe(false);
  });

  it('maps unknown → 404, ambiguous → 400, missing → 400', async () => {
    const id = await eventId();
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ id: 'a2', fullName: 'Ada Lovelace', email: 'ada2@engines.dev', source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
    expect((await post(id, { contact: 'Nobody' })).status).toBe(404);
    expect((await post(id, { contact: 'Ada Lovelace' })).status).toBe(400);
    expect((await post(id, {})).status).toBe(400);
  });

  it('refuses a soft-deleted contact', async () => {
    const id = await eventId();
    expect((await post(id, { contactId: 'gone' })).status).toBe(404);
  });

  it('404s an unknown event', async () => {
    expect((await post('nope', { contactId: 'a' })).status).toBe(404);
  });
});

describe('DELETE /api/events/[id]/attendees', () => {
  it('removes an attendance row and reports whether it existed', async () => {
    const id = await eventId();
    await post(id, { contactId: 'a' });
    const first = await del(id, '?contactId=a');
    expect(first.status).toBe(200);
    expect(((await first.json()) as { removed: boolean }).removed).toBe(true);
    expect(((await (await del(id, '?contactId=a')).json()) as { removed: boolean }).removed).toBe(false);
  });

  it('accepts a selector and requires one', async () => {
    const id = await eventId();
    await post(id, { contactId: 'b' });
    const res = await del(id, `?contact=${encodeURIComponent('bob@builders.io')}`);
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true);
    expect((await del(id, '')).status).toBe(400);
  });
});
