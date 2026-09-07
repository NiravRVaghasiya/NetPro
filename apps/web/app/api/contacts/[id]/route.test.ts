import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET } from './route';

const NOW_ISO = new Date().toISOString();

function seed() {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values([
      {
        id: 'c1',
        fullName: 'Jane Doe',
        company: 'Stripe',
        source: 'test',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        id: 'gone',
        fullName: 'Deleted Person',
        source: 'test',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: NOW_ISO,
      },
    ])
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.interactions)
    .values({
      id: 'i1',
      contactId: 'c1',
      type: 'meeting',
      occurredAt: NOW_ISO,
      createdAt: NOW_ISO,
    })
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.followUps)
    .values({
      id: 'f1',
      contactId: 'c1',
      dueAt: NOW_ISO,
      status: 'pending',
      createdAt: NOW_ISO,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM follow_ups; DELETE FROM interactions; DELETE FROM contacts;'
  );
  seed();
});
afterAll(() => fixture.sqlite.close());

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/contacts/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/contacts/[id]', () => {
  it('returns the full timeline aggregate', async () => {
    const res = await get('c1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { fullName: string };
      stats: { interactionCount: number };
      interactions: Array<{ id: string }>;
      followUps: Array<{ id: string }>;
    };
    expect(body.contact.fullName).toBe('Jane Doe');
    expect(body.interactions.map((i) => i.id)).toEqual(['i1']);
    expect(body.followUps.map((f) => f.id)).toEqual(['f1']);
    expect(body.stats.interactionCount).toBe(0); // stats are denormalized; seeded row didn't update them
  });

  it('404s for unknown and soft-deleted contacts', async () => {
    expect((await get('missing')).status).toBe(404);
    expect((await get('gone')).status).toBe(404);
  });

  it('is private/no-store', async () => {
    const res = await get('c1');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
