import { describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  const f = createTestSqliteConn();
  const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();
  const rows = [
    {
      id: 'a',
      fullName: 'Ada Lovelace',
      email: 'ada@engines.dev',
      company: 'Engines',
      headline: 'Staff engineer — Python, Kubernetes, AWS',
      relationshipScore: 0.9,
    },
    { id: 'b', fullName: 'Bob Bridge', role: 'Data Engineer', notes: 'SQL, dbt and Airflow.', tags: ['python'], relationshipScore: 0.6 },
    { id: 'c', fullName: 'Cara', headline: 'Product designer (Figma)', skills: ['rust', 'figma'], relationshipScore: 0.3 },
    { id: 'dup1', fullName: 'Sam Same', headline: 'Python', relationshipScore: 0.2 },
    { id: 'dup2', fullName: 'Sam Same', headline: 'Python', relationshipScore: 0.2 },
    { id: 'gone', fullName: 'Ghost', headline: 'Python everything', deletedAt: NOW },
  ];
  for (const r of rows) {
    await f.conn.db.insert(f.conn.schema.contacts).values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW });
  }
  return f;
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import { GET } from './route';

const get = (qs: string) => GET(new Request(`http://localhost/api/skills/gap${qs}`));

interface NetworkBody {
  required: string[];
  contactCount: number;
  coverage: Array<{ skill: string; count: number; partialCount: number; contacts: Array<{ id: string }> }>;
  gaps: string[];
  coveredCount: number;
  candidates: Array<{ id: string; gap: { matchScore: number } }>;
  target: { unrecognized: string[] };
}

describe('GET /api/skills/gap', () => {
  it('rejects an empty target with 400', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Provide at least one of role, description or skills.' });
    expect((await get('?role=%20%20')).status).toBe(400);
  });

  it('analyses the live network for a role + explicit skills', async () => {
    const res = await get('?role=Data%20Engineer&skills=python,k8s,rust');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as NetworkBody;
    expect(body.required).toEqual(['python', 'rust', 'kubernetes', 'data engineering']);
    expect(body.contactCount).toBe(5); // the soft-deleted contact is never scanned
    const python = body.coverage.find((c) => c.skill === 'python')!;
    expect(python.count).toBe(4);
    expect(python.contacts.map((c) => c.id)).toEqual(['a', 'b', 'dup1', 'dup2']);
    expect(body.coverage.find((c) => c.skill === 'rust')!.count).toBe(1); // stored claim counts
    expect(body.gaps).toEqual([]);
    expect(body.candidates[0]).toMatchObject({ id: 'a', gap: { matchScore: 0.5 } });
    expect(body.candidates.map((c) => c.id)).not.toContain('gone');
  });

  it('reports unrecognised names and honours limit / perSkill bounds', async () => {
    const body = (await (await get('?skills=python,cobol&limit=1&perSkill=2')).json()) as NetworkBody;
    expect(body.target.unrecognized).toEqual(['cobol']);
    expect(body.candidates).toHaveLength(1);
    expect(body.coverage[0]!.contacts).toHaveLength(2);
    expect(body.coverage[0]!.count).toBe(4);
    // Garbage falls back to defaults rather than erroring.
    const loose = (await (await get('?skills=python&limit=abc&perSkill=-4')).json()) as NetworkBody;
    expect(loose.candidates.length).toBeGreaterThan(1);
    expect(loose.coverage[0]!.contacts).toHaveLength(1);
  });

  it('returns an empty-but-honest analysis when nothing in the target is a skill', async () => {
    const body = (await (await get('?description=a%20kind%20person')).json()) as NetworkBody;
    expect(body.required).toEqual([]);
    expect(body.coverage).toEqual([]);
    expect(body.candidates).toEqual([]);
  });

  it('caps pathological targets at 400 rather than scanning them', async () => {
    const res = await get(`?description=${'x'.repeat(10_001)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/10000 characters or fewer/);
  });

  it('compares one contact when ?contact= is given (name, email or id)', async () => {
    const res = await get('?contact=ada%40engines.dev&skills=python,rust,javascript');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contact).toMatchObject({ id: 'a', fullName: 'Ada Lovelace' });
    expect(body.gap).toMatchObject({ present: ['python'], missing: ['javascript', 'rust'], matchScore: 0.33 });

    // Stored claims count for the contact comparison too.
    const cara = await (await get('?contact=c&skills=rust,figma')).json();
    expect(cara.gap).toMatchObject({ present: ['rust', 'figma'], matchScore: 1 });
  });

  it('answers unknown → 404 and ambiguous → 400 through the shared resolver', async () => {
    const missing = await get('?contact=nobody&skills=python');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/No contact matches "nobody"/);

    const ambiguous = await get('?contact=Sam%20Same&skills=python');
    expect(ambiguous.status).toBe(400);
    expect((await ambiguous.json()).error).toMatch(/Ambiguous contact "Sam Same"/);

    const deleted = await get('?contact=Ghost&skills=python');
    expect(deleted.status).toBe(404);
  });
});
