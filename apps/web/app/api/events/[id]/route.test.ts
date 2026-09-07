import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { DELETE, GET } from './route';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  for (const r of [
    { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', industry: 'fintech', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', company: 'Builders', industry: 'fintech', relationshipScore: 0.6 },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

async function createEvent(name = 'React Conf'): Promise<string> {
  const { upsertEvent } = await import('@netpro/core/src/events');
  const { event } = await upsertEvent(fixture.conn, { name, startsAt: '2026-09-14' }, { now: new Date(NOW) });
  return event.id;
}

async function link(eventId: string, contactId: string): Promise<void> {
  const { linkAttendee } = await import('@netpro/core/src/events');
  await linkAttendee(fixture.conn, { eventId, contactId, via: 'manual', edges: false }, { now: new Date(NOW) });
}

const get = (id: string) => GET(new Request(`http://localhost/api/events/${id}`), { params: Promise.resolve({ id }) });
const del = (id: string) =>
  DELETE(new Request(`http://localhost/api/events/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

interface DetailBody {
  event: { id: string; name: string; startsAt: string | null };
  attendees: Array<{ contactId: string; fullName: string; attended: boolean }>;
  attendeeCount: number;
  industries: string[];
  companies: string[];
  unmatched: Array<{ email: string | null; name: string | null; reason: string }>;
}

describe('GET /api/events/[id]', () => {
  it('returns the overlap with the network', async () => {
    const id = await createEvent();
    await link(id, 'a');
    await link(id, 'b');
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.event.name).toBe('React Conf');
    expect(body.attendeeCount).toBe(2);
    // Strongest tie first.
    expect(body.attendees.map((a) => a.contactId)).toEqual(['a', 'b']);
    expect(body.industries).toEqual(['fintech']);
    expect(body.companies).toEqual(['Builders', 'Engines']);
    expect(body.unmatched).toEqual([]);
  });

  it('resolves an event by exact name', async () => {
    const id = await createEvent();
    const body = (await (await get('react conf')).json()) as DetailBody;
    expect(body.event.id).toBe(id);
  });

  it('marks a future event as planned, not attended', async () => {
    const id = await createEvent('Future Conf');
    await link(id, 'a');
    const body = (await (await get(id)).json()) as DetailBody;
    expect(body.attendees[0]!.attended).toBe(false);
  });

  it('404s an unknown event', async () => {
    const res = await get('nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('No event found');
  });
});

describe('DELETE /api/events/[id]', () => {
  it('removes the event and its attendance rows', async () => {
    const id = await createEvent();
    await link(id, 'a');
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: { name: string } }).removed.name).toBe('React Conf');
    expect((await get(id)).status).toBe(404);
  });

  it('404s on a second delete', async () => {
    const id = await createEvent();
    await del(id);
    expect((await del(id)).status).toBe(404);
  });
});
