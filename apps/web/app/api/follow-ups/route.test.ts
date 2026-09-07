import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET, POST } from './route';
import { GET as GetById, PATCH } from './[id]/route';

const NOW_ISO = new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;

function seed() {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: 'c1',
      fullName: 'Jane Doe',
      source: 'test',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM activity_log; DELETE FROM follow_ups; DELETE FROM contacts;');
  seed();
});
afterAll(() => fixture.sqlite.close());

function post(body: unknown): Request {
  return new Request('http://localhost/api/follow-ups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(new Request(`http://localhost/api/follow-ups/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

describe('POST /api/follow-ups', () => {
  it('schedules a relative follow-up (201) and a recurring one', async () => {
    const res = await POST(post({ contactId: 'c1', dueInMs: 7 * DAY, reason: 'Send deck' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; dueAt: string; contactName: string; recurring: boolean };
    expect(body.contactName).toBe('Jane Doe');
    expect(body.recurring).toBe(false);
    expect(Date.parse(body.dueAt) - Date.now()).toBeGreaterThan(6 * DAY);

    const recurring = await POST(
      post({ contactId: 'c1', dueInMs: DAY, recurrenceRule: '30d' })
    );
    expect(recurring.status).toBe(201);
    expect(((await recurring.json()) as { recurring: boolean }).recurring).toBe(true);
  });

  it('accepts string dueInMs (form-encoded clients) and absolute dueAt', async () => {
    const viaString = await POST(post({ contactId: 'c1', dueInMs: String(2 * DAY) }));
    expect(viaString.status).toBe(201);
    const absolute = await POST(post({ contactId: 'c1', dueAt: '2026-12-24T09:00:00Z' }));
    expect(absolute.status).toBe(201);
    expect(((await absolute.json()) as { dueAt: string }).dueAt).toBe('2026-12-24T09:00:00.000Z');
  });

  it('validates: missing due target, unknown contact, bad rule', async () => {
    expect((await POST(post({ contactId: 'c1' }))).status).toBe(400);
    expect((await POST(post({ contactId: 'nobody', dueInMs: DAY }))).status).toBe(404);
    expect(
      (await POST(post({ contactId: 'c1', dueInMs: DAY, recurrenceRule: 'whenever' }))).status
    ).toBe(400);
  });
});

describe('GET /api/follow-ups', () => {
  it('lists pending with counts and filters by view/contact', async () => {
    await POST(post({ contactId: 'c1', dueInMs: DAY }));
    await POST(post({ contactId: 'c1', dueInMs: 30 * DAY }));

    const pending = (await (
      await GET(new Request('http://localhost/api/follow-ups'))
    ).json()) as { followUps: unknown[]; counts: { pending: number; dueToday: number } };
    expect(pending.followUps).toHaveLength(2);
    expect(pending.counts.pending).toBe(2);

    const overdue = (await (
      await GET(new Request('http://localhost/api/follow-ups?view=overdue'))
    ).json()) as { followUps: unknown[] };
    expect(overdue.followUps).toHaveLength(0);

    expect(
      (await GET(new Request('http://localhost/api/follow-ups?view=nonsense'))).status
    ).toBe(400);
  });
});

describe('GET/PATCH /api/follow-ups/[id]', () => {
  async function createOne(): Promise<string> {
    const res = await POST(post({ contactId: 'c1', dueInMs: DAY, reason: 'Ping' }));
    return ((await res.json()) as { id: string }).id;
  }

  it('GET returns the follow-up or 404', async () => {
    const id = await createOne();
    const res = await GetById(new Request(`http://localhost/api/follow-ups/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);

    const missing = await GetById(new Request('http://localhost/api/follow-ups/x'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('PATCH complete/snooze/cancel with status mapping', async () => {
    const id = await createOne();

    const snoozed = await patch(id, { action: 'snooze', forMs: 3 * DAY });
    expect(snoozed.status).toBe(200);
    expect(((await snoozed.json()) as { snoozedUntil: string | null }).snoozedUntil).not.toBeNull();

    const completed = await patch(id, { action: 'complete' });
    expect(completed.status).toBe(200);
    const body = (await completed.json()) as {
      completed: { status: string };
      next: unknown;
    };
    expect(body.completed.status).toBe('completed');
    expect(body.next).toBeNull();

    // completing twice is a conflict
    expect((await patch(id, { action: 'complete' })).status).toBe(409);
    // unknown action is a validation error
    expect((await patch(id, { action: 'explode' })).status).toBe(400);
    // unknown id is a 404
    expect((await patch('nope', { action: 'complete' })).status).toBe(404);
  });

  it('PATCH snooze needs a target', async () => {
    const id = await createOne();
    expect((await patch(id, { action: 'snooze' })).status).toBe(400);
  });
});
