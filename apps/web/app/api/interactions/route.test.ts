import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET, POST } from './route';

const NOW_ISO = new Date().toISOString();

function seed() {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: 'c1',
      fullName: 'Jane Doe',
      email: 'jane@stripe.com',
      source: 'test',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM activity_log; DELETE FROM interactions; DELETE FROM contacts;');
  seed();
});
afterAll(() => fixture.sqlite.close());

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/interactions', () => {
  it('logs an interaction, recomputes stats, and returns 201', async () => {
    const res = await POST(
      post({ contactId: 'c1', type: 'meeting', channel: 'in_person', content: 'Coffee' })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      interaction: { id: string; type: string; content: string };
      stats: { interactionCount: number; lastInteraction: string | null; relationshipScore: number };
      contact: { fullName: string };
    };
    expect(body.interaction.type).toBe('meeting');
    expect(body.interaction.content).toBe('Coffee');
    expect(body.contact.fullName).toBe('Jane Doe');
    expect(body.stats.interactionCount).toBe(1);
    expect(body.stats.relationshipScore).toBeGreaterThan(0);

    const row = fixture.sqlite
      .prepare('SELECT interaction_count AS n FROM contacts WHERE id = ?')
      .get('c1') as { n: number };
    expect(row.n).toBe(1);
    const audit = fixture.sqlite
      .prepare("SELECT count(*) AS n FROM activity_log WHERE action = 'interaction.logged'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('maps validation failures to 400 with the core message', async () => {
    const res = await POST(post({ contactId: 'c1', type: 'carrier-pigeon' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string; code: string }).code).toBe('invalid_input');
  });

  it('maps unknown contacts to 404', async () => {
    const res = await POST(post({ contactId: 'nobody', type: 'note' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('rejects non-JSON content types (415) and oversized bodies (413)', async () => {
    const wrongType = await POST(
      post({ contactId: 'c1', type: 'note' }, { 'content-type': 'text/plain' })
    );
    expect(wrongType.status).toBe(415);

    const huge = await POST(
      post({ contactId: 'c1', type: 'note', content: 'x'.repeat(20 * 1024) })
    );
    expect(huge.status).toBe(413);
  });

  it('rejects malformed JSON and non-object bodies with 400', async () => {
    expect((await POST(post('{oops'))).status).toBe(400);
    expect((await POST(post([1, 2, 3]))).status).toBe(400);
  });
});

describe('GET /api/interactions', () => {
  it('lists history per contact, newest first, with totals', async () => {
    await POST(post({ contactId: 'c1', type: 'note', occurredAt: '2026-09-01T10:00:00Z' }));
    await POST(post({ contactId: 'c1', type: 'call', occurredAt: '2026-09-03T10:00:00Z' }));

    const res = await GET(new Request('http://localhost/api/interactions?contactId=c1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      interactions: Array<{ type: string; contactName: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.interactions.map((i) => i.type)).toEqual(['call', 'note']);
    expect(body.interactions[0]!.contactName).toBe('Jane Doe');
  });

  it('paginates and clamps', async () => {
    await POST(post({ contactId: 'c1', type: 'note', occurredAt: '2026-09-01T10:00:00Z' }));
    await POST(post({ contactId: 'c1', type: 'call', occurredAt: '2026-09-03T10:00:00Z' }));
    const res = await GET(new Request('http://localhost/api/interactions?limit=1&offset=1'));
    const body = (await res.json()) as { interactions: Array<{ type: string }>; total: number };
    expect(body.interactions.map((i) => i.type)).toEqual(['note']);
    expect(body.total).toBe(2);
  });
});
