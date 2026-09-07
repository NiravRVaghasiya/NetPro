import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

const NOW_ISO = new Date().toISOString();

function seed() {
  for (const [id, name] of [
    ['c1', 'Jane Doe'],
    ['c2', 'Pat Lee'],
  ] as const) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id,
        fullName: name,
        email: `${id}@example.com`,
        source: 'test',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      })
      .run();
  }
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM contacts;');
  seed();
});
afterAll(() => fixture.sqlite.close());

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/edges', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/edges', () => {
  it('creates a confirmed manual edge and returns 201', async () => {
    const res = await POST(post({ sourceId: 'c1', targetId: 'c2', relation: 'colleague' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { edge: { relation: string; status: string } };
    expect(body.edge.relation).toBe('colleague');
    expect(body.edge.status).toBe('confirmed');
  });

  it('maps validation failures to 400 and unknown contacts to 404', async () => {
    expect((await POST(post({ sourceId: 'c1', targetId: 'c1' }))).status).toBe(400);
    expect((await POST(post({ sourceId: 'c1', targetId: 'nobody' }))).status).toBe(404);
    const unknownRel = await POST(post({ sourceId: 'c1', targetId: 'c2', relation: 'besties' }));
    expect(unknownRel.status).toBe(400);
    expect(((await unknownRel.json()) as { code: string }).code).toBe('invalid_input');
  });

  it('rejects non-JSON and oversized bodies', async () => {
    expect((await POST(post({ sourceId: 'c1', targetId: 'c2' }, { 'content-type': 'text/plain' }))).status).toBe(415);
  });

  it('records event attendance', async () => {
    const res = await POST(post({ contactId: 'c1', eventName: 'React Conf' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { name: string } };
    expect(body.event.name).toBe('React Conf');
  });
});

describe('GET /api/edges', () => {
  it('lists edges with totals', async () => {
    await POST(post({ sourceId: 'c1', targetId: 'c2' }));
    const res = await GET(new Request('http://localhost/api/edges'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.edges).toHaveLength(1);
  });
});

describe('/api/edges/[id]', () => {
  it('confirms and deletes', async () => {
    const created = await POST(
      post({ sourceId: 'c1', targetId: 'c2', source: 'linkedin_csv', status: 'pending', relation: 'mutual_network' })
    );
    const { edge } = (await created.json()) as { edge: { id: string } };
    const patched = await PATCH(
      new Request(`http://localhost/api/edges/${edge.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      }),
      { params: Promise.resolve({ id: edge.id }) }
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { edge: { status: string } }).edge.status).toBe('confirmed');

    const deleted = await DELETE(new Request(`http://localhost/api/edges/${edge.id}`), {
      params: Promise.resolve({ id: edge.id }),
    });
    expect(deleted.status).toBe(200);
  });

  it('maps unknown ids to 404', async () => {
    const res = await DELETE(new Request('http://localhost/api/edges/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});
