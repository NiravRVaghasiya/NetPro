vi.mock('@/lib/authz', () => ({ requireMembership: async () => ({ workspaceId: 'default', userId: 'test-user', role: 'member' }) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

// The AI pass must never reach the network from this suite. Stub the provider
// factory so a "configured" environment yields a deterministic fake model.
const complete = vi.hoisted(() => vi.fn());
vi.mock('@netpro/core/src/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@netpro/core/src/ai')>();
  return {
    ...actual,
    resolveAiProvider: (credentials: { openaiKey?: string | null; anthropicKey?: string | null }) => {
      if (!credentials.openaiKey && !credentials.anthropicKey) {
        throw new actual.AiProviderError('not_configured', 'No AI provider key configured.');
      }
      return { id: 'openai', label: 'fake', defaultModel: 'fake-model', complete };
    },
  };
});

import { GET, POST } from './route';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

function post(body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request('http://localhost/api/skills/extract', {
      method: 'POST',
      headers: body === undefined ? { 'content-length': '0', ...headers } : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM enrichments; DELETE FROM activity_log; DELETE FROM search_index; DELETE FROM contacts;');
  const rows = [
    { id: 'a', fullName: 'Ada Lovelace', headline: 'Staff engineer — Python, Kubernetes, AWS' },
    { id: 'b', fullName: 'Bob Bridge', role: 'Data Engineer', notes: 'SQL and dbt.' },
    { id: 'c', fullName: 'Cara', headline: 'Product designer (Figma)', skills: ['rust', 'figma'] },
    { id: 'gone', fullName: 'Ghost', headline: 'Python', deletedAt: NOW },
  ];
  for (const r of rows) {
    fixture.conn.db.insert(fixture.conn.schema.contacts).values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW }).run();
  }
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_PROVIDER', '');
  complete.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/skills/extract', () => {
  it('reports coverage counts over live contacts', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: 3, withSkills: 1, neverExtracted: 2 });
  });
});

describe('POST /api/skills/extract', () => {
  it('extracts heuristically for every live contact with an empty body, and is idempotent', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 3, updated: 3, unchanged: 0, withSkills: 3, mode: 'heuristic', dryRun: false });
    expect(body.changes.find((c: { contactId: string }) => c.contactId === 'a').after).toEqual(['python', 'aws', 'kubernetes']);
    expect(body.indexed).toEqual({ indexed: 3, skipped: 0 });
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM enrichments WHERE provider = 'skills_heuristic'").get()).toEqual({ n: 3 });
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM activity_log WHERE action = 'skills.extracted'").get()).toEqual({ n: 3 });

    const again = await (await post({})).json();
    expect(again).toMatchObject({ scanned: 3, updated: 0, unchanged: 3 });
    expect(await (await GET()).json()).toEqual({ contacts: 3, withSkills: 3, neverExtracted: 0 });
  });

  it('previews with dryRun and scopes to one contact', async () => {
    const dry = await (await post({ dryRun: true, contact: 'Bob Bridge' })).json();
    expect(dry).toMatchObject({ scanned: 1, updated: 1, dryRun: true });
    expect(dry.changes[0]).toMatchObject({ contactId: 'b', before: [] });
    expect(dry.changes[0].after).toEqual(expect.arrayContaining(['sql', 'dbt', 'data engineering']));
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM enrichments').get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare("SELECT skills FROM contacts WHERE id = 'b'").get()).toEqual({ skills: null });
  });

  it('validates the body: bad JSON, wrong content type, unknown mode, unknown/ambiguous contact', async () => {
    const notJson = await POST(
      new Request('http://localhost/api/skills/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{nope',
      }),
    );
    expect(notJson.status).toBe(400);

    const wrongType = await POST(
      new Request('http://localhost/api/skills/extract', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    );
    expect(wrongType.status).toBe(415);

    const badMode = await post({ mode: 'llm' });
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).error).toMatch(/Unknown mode "llm"/);

    expect((await post({ contact: 'nobody' })).status).toBe(404);
    expect((await post({ contact: 'Ghost' })).status).toBe(404);
    expect((await post({ mode: 'ai', provider: 'bard' })).status).toBe(400);
  });

  it('refuses mode=ai without a server-side key, before touching the database', async () => {
    const res = await post({ mode: 'ai' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'ai_not_configured' });
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM enrichments').get()).toEqual({ n: 0 });
  });

  it('runs the AI pass when a key is configured, keeping the model inside the taxonomy', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    // The model may only pick taxonomy names; "cobol" and prose are dropped.
    complete.mockResolvedValue('["typescript", "cobol", "not a skill"]');
    const res = await post({ mode: 'ai', contact: 'a' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 1, mode: 'ai', aiErrors: [] });
    expect(body.changes[0].after).toEqual(['typescript', 'python', 'aws', 'kubernetes']); // taxonomy order
    expect(complete).toHaveBeenCalledTimes(1);
    // One evidence row per (contact, extractor): an AI run's payload carries
    // the heuristic details too, so it is filed under `skills_ai` only.
    const row = fixture.sqlite.prepare("SELECT provider, raw_payload FROM enrichments WHERE contact_id = 'a'").all() as Array<{
      provider: string;
      raw_payload: string;
    }>;
    expect(row.map((r) => r.provider)).toEqual(['skills_ai']);
    const payload = JSON.parse(row[0]!.raw_payload) as { details: Array<{ skill: string; source: string }> };
    expect(payload.details.find((d) => d.skill === 'typescript')).toMatchObject({ source: 'ai' });
    expect(payload.details.find((d) => d.skill === 'python')).toMatchObject({ source: 'heuristic' });
  });

  it('degrades to the heuristic result when the model call fails, and says so', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    complete.mockRejectedValue(new Error('rate limited'));
    const body = await (await post({ mode: 'ai', contact: 'a' })).json();
    expect(body.aiErrors).toEqual([{ contactId: 'a', error: 'upstream_error: AI provider request failed. Check credentials and provider availability.' }]);
    expect(body.changes[0].after).toEqual(['python', 'aws', 'kubernetes']);
  });
});
