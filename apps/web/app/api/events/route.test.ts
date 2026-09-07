import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET, POST } from './route';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

function seed(): void {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  const rows = [
    { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', industry: 'fintech', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', company: 'Builders', industry: 'fintech', relationshipScore: 0.6 },
  ];
  for (const r of rows) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
}

beforeEach(seed);
afterAll(() => fixture.sqlite.close());

const get = (qs = '') => GET(new Request(`http://localhost/api/events${qs}`));
const postJson = (body: unknown) =>
  POST(
    new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

function postCsv(csv: string, qs = ''): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([csv], 'events.csv', { type: 'text/csv' }));
  return POST(new Request(`http://localhost/api/events${qs}`, { method: 'POST', body: form }));
}

interface ListBody {
  events: Array<{ id: string; name: string; attendeeCount: number }>;
  total: number;
  limit: number;
  offset: number;
}

interface ImportBody {
  events: number;
  created: number;
  attendees: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  edges: number;
  unmatchedRefs: Array<{ email: string | null; name: string | null }>;
  ambiguousRefs: Array<{ candidates: Array<{ id: string }> }>;
  dryRun: boolean;
  errors: Array<{ row: number; reason: string }>;
}

describe('GET /api/events', () => {
  it('lists events with network-attendee counts', async () => {
    await postJson({ name: 'React Conf', location: 'Berlin', startsAt: '2026-09-14' });
    const res = await get('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.events[0]).toMatchObject({ name: 'React Conf', attendeeCount: 0 });
  });

  it('filters and paginates', async () => {
    for (const name of ['React Conf', 'RustConf', 'PyCon']) await postJson({ name });
    const body = (await (await get('?query=conf&limit=2')).json()) as ListBody;
    expect(body.total).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.events.map((e) => e.name)).toEqual(['React Conf', 'RustConf']);
  });

  it('ignores a garbage limit instead of 500ing', async () => {
    const body = (await (await get('?limit=abc&offset=-4')).json()) as ListBody;
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('rejects an over-long query', async () => {
    const res = await get(`?query=${'x'.repeat(201)}`);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string field with 400', async () => {
    const res = await postJson({ name: 42 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/events — create', () => {
  it('creates an event and dedupes on name', async () => {
    const first = await postJson({ name: 'React Conf', startsAt: '2026-09-14' });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { created: boolean }).created).toBe(true);

    const second = await postJson({ name: '  react conf  ' });
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
  });

  it('rejects a bad date with 400', async () => {
    const res = await postJson({ name: 'Conf', startsAt: 'whenever' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not a date');
  });
});

describe('POST /api/events — CSV import', () => {
  const csv = [
    'name,location,starts_at,attendees',
    'React Conf,Berlin,2026-09-14,"ada@engines.dev; bob@builders.io; nobody@nowhere.dev"',
  ].join('\n');

  it('imports, matches attendees and reports the unmatched bucket', async () => {
    const res = await postCsv(csv);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportBody;
    expect(body.created).toBe(1);
    expect(body.matched).toBe(2);
    expect(body.attendees).toBe(2);
    expect(body.edges).toBe(1);
    expect(body.unmatchedRefs).toEqual([{ name: null, email: 'nobody@nowhere.dev', reason: expect.any(String) }]);
  });

  it('previews with ?dryRun=1 and writes nothing', async () => {
    const body = (await (await postCsv(csv, '?dryRun=1')).json()) as ImportBody;
    expect(body.dryRun).toBe(true);
    expect(body.matched).toBe(2);
    const list = (await (await get('')).json()) as ListBody;
    expect(list.total).toBe(0);
  });

  it('accepts a JSON { csv } body too', async () => {
    const res = await postJson({ csv });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ImportBody).attendees).toBe(2);
  });

  it('reports ambiguous lines with candidates and links nothing', async () => {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ id: 'a2', fullName: 'Ada Lovelace', email: 'ada2@engines.dev', source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
    const body = (await (await postCsv('name,names\nMeetup,Ada Lovelace')).json()) as ImportBody;
    expect(body.ambiguous).toBe(1);
    expect(body.attendees).toBe(0);
    expect(body.ambiguousRefs[0]!.candidates.map((c) => c.id)).toEqual(['a', 'a2']);
  });

  it('surfaces parse errors per row', async () => {
    const body = (await (await postCsv('name,starts_at\nGood,2026-09-14\nBad,whenever')).json()) as ImportBody;
    expect(body.created).toBe(1);
    expect(body.errors).toHaveLength(1);
  });

  it('400s on an upload with no file', async () => {
    const form = new FormData();
    const res = await POST(new Request('http://localhost/api/events', { method: 'POST', body: form }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('CSV file is required');
  });
});
