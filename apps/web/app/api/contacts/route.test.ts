import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET } from './route';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * 09:00 UTC on the *real* run day. The route buckets follow-ups against the
 * live clock (due < startOfToday → overdue), so a fixed seed date would drift
 * out of "due today" as the calendar moves; this keeps the counts assertion
 * deterministic whenever the suite runs.
 */
const DUE_TODAY = (() => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9)
  ).toISOString();
})();

function seed() {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values([
      {
        id: 'c1',
        fullName: 'Jane Doe',
        company: 'Stripe',
        role: 'Engineer',
        source: 'test',
        lastInteraction: new Date(NOW.getTime() - DAY).toISOString(),
        interactionCount: 2,
        relationshipScore: 0.6,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'c2',
        fullName: 'John Smith',
        source: 'test',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ])
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.followUps)
    .values({
      id: 'f1',
      contactId: 'c1',
      dueAt: DUE_TODAY,
      status: 'pending',
      createdAt: NOW.toISOString(),
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM follow_ups; DELETE FROM interactions; DELETE FROM contacts;');
  seed();
});
afterAll(() => fixture.sqlite.close());

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const res = await GET(new Request(url));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/contacts', () => {
  it('returns the CRM page with stats, next follow-up, and counts', async () => {
    const { status, body } = await get('http://localhost/api/contacts');
    expect(status).toBe(200);
    const page = body as {
      contacts: Array<{ id: string; nextFollowUpAt: string | null; interactionCount: number }>;
      total: number;
      followUpCounts: { overdue: number; dueToday: number; upcoming: number; pending: number };
    };
    expect(page.total).toBe(2);
    // recent sort: Jane (touched yesterday) before John (never)
    expect(page.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(page.contacts[0]!.nextFollowUpAt).toBe(DUE_TODAY);
    expect(page.contacts[0]!.interactionCount).toBe(2);
    expect(page.contacts[1]!.nextFollowUpAt).toBeNull();
    expect(page.followUpCounts).toEqual({ overdue: 0, dueToday: 1, upcoming: 0, pending: 1 });
  });

  it('honors sort, limit, and offset; ignores unknown sorts', async () => {
    const byName = (await get('http://localhost/api/contacts?sort=name')).body as {
      contacts: Array<{ id: string }>;
      sort: string;
    };
    expect(byName.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(byName.sort).toBe('name');

    const paged = (await get('http://localhost/api/contacts?sort=name&limit=1&offset=1')).body as {
      contacts: Array<{ id: string }>;
      total: number;
    };
    expect(paged.contacts.map((c) => c.id)).toEqual(['c2']);
    expect(paged.total).toBe(2);

    const bogus = (await get('http://localhost/api/contacts?sort=bogus')).body as { sort: string };
    expect(bogus.sort).toBe('recent');
  });

  it('is private/no-store', async () => {
    const res = await GET(new Request('http://localhost/api/contacts'));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
