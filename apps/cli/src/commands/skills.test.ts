import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  executeSkillsExtract,
  executeSkillsGap,
  executeSkillsProfile,
  executeSkillsStatus,
  parseExtractMode,
  renderExtractSummary,
  renderNetworkGaps,
  toSkillTarget,
} from './skills';

const fixture = createTestSqliteConn();
const now = new Date('2026-09-07T12:00:00Z');

interface Seed {
  id: string;
  fullName: string;
  email?: string | null;
  headline?: string | null;
  role?: string | null;
  company?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  skills?: string[] | null;
  relationshipScore?: number;
  deletedAt?: string | null;
}

const SEED: Seed[] = [
  {
    id: 'a',
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    headline: 'Staff engineer — Python, Kubernetes, AWS',
    company: 'Analytical',
    relationshipScore: 0.9,
  },
  {
    id: 'b',
    fullName: 'Bob Builder',
    email: 'bob@example.com',
    role: 'Data Engineer',
    notes: 'Strong in SQL and dbt; runs Airflow at scale.',
    tags: ['python'],
    relationshipScore: 0.4,
  },
  {
    id: 'c',
    fullName: 'Cy Fields',
    headline: 'Product designer (Figma)',
    skills: ['rust', 'figma'],
    relationshipScore: 0.6,
  },
  { id: 'gone', fullName: 'Ghost', headline: 'Python everything', deletedAt: now.toISOString() },
];

function seed(): void {
  fixture.sqlite.exec('DELETE FROM enrichments; DELETE FROM activity_log; DELETE FROM search_index; DELETE FROM contacts;');
  for (const s of SEED) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id: s.id,
        fullName: s.fullName,
        email: s.email ?? null,
        headline: s.headline ?? null,
        role: s.role ?? null,
        company: s.company ?? null,
        notes: s.notes ?? null,
        tags: s.tags ?? null,
        skills: s.skills ?? null,
        relationshipScore: s.relationshipScore ?? 0,
        deletedAt: s.deletedAt ?? null,
        source: 'test',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();
  }
}

let tempHome: string;
beforeEach(() => {
  seed();
  // Isolate the keychain so a developer machine with real AI keys can never
  // make `--mode ai` perform a live call from this suite.
  tempHome = mkdtempSync(join(tmpdir(), 'netpro-skills-test-'));
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('USERPROFILE', tempHome);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_PROVIDER', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempHome, { recursive: true, force: true });
});
afterAll(() => fixture.sqlite.close());

describe('flag parsing', () => {
  it('requires a target for gap', () => {
    expect(() => toSkillTarget({})).toThrow(/Provide a target/);
    expect(() => toSkillTarget({ role: '   ' })).toThrow(/Provide a target/);
    expect(toSkillTarget({ role: ' Data Engineer ', skills: 'python' })).toEqual({
      role: 'Data Engineer',
      description: null,
      skills: 'python',
    });
  });

  it('validates --mode', () => {
    expect(parseExtractMode(undefined)).toBe('heuristic');
    expect(parseExtractMode('ai')).toBe('ai');
    expect(() => parseExtractMode('llm')).toThrow(/Unknown --mode "llm"/);
  });
});

describe('netpro skills <contact>', () => {
  it('shows stored + current skills with evidence, and resolves by name/email/id', async () => {
    const out = await executeSkillsProfile('ada@example.com', {}, fixture.conn);
    expect(out).toContain('Skills for Ada Lovelace <ada@example.com>');
    expect(out).toContain('Stored: none yet');
    expect(out).toMatch(/python \[languages\] 1\.00 — headline: “Staff engineer — Python, Kubernetes, AWS”/);
    expect(out).toContain('kubernetes');

    const cy = await executeSkillsProfile('Cy Fields', {}, fixture.conn);
    expect(cy).toContain('Stored (2): rust, figma');
    expect(cy).toContain('Stored but not supported by the current text: rust');

    const json = JSON.parse(await executeSkillsProfile('b', { json: true }, fixture.conn)) as {
      stored: string[];
      current: { skills: string[] };
    };
    expect(json.stored).toEqual([]);
    expect(json.current.skills).toEqual(expect.arrayContaining(['python', 'sql', 'dbt', 'airflow', 'data engineering']));
  });

  it('fails clearly for an unknown or deleted contact', async () => {
    await expect(executeSkillsProfile('nobody@example.com', {}, fixture.conn)).rejects.toThrow(/No contact/);
    await expect(executeSkillsProfile('Ghost', {}, fixture.conn)).rejects.toThrow(/No contact/);
  });
});

describe('netpro skills gap', () => {
  it('analyses the whole network for a role + explicit skills', async () => {
    const out = await executeSkillsGap({ role: 'Data Engineer', skills: 'python, k8s, rust' }, fixture.conn);
    expect(out).toContain('Target needs 4 skills: python, rust, kubernetes, data engineering');
    expect(out).toContain('Network: 3 contacts scanned');
    expect(out).toMatch(/python \[languages\] — 2/);
    expect(out).toMatch(/Ada Lovelace · score 0\.90/);
    // Cy's stored `rust` counts even though nothing in the text supports it.
    expect(out).toMatch(/rust \[languages\] — 1/);
    expect(out).toContain('Best matches:');
    expect(out).toMatch(/#1 Ada Lovelace \(Analytical\) — 50%/);
    expect(out).not.toContain('Ghost');
  });

  it('reports gaps nobody covers and ignores names outside the taxonomy', async () => {
    const out = await executeSkillsGap({ skills: 'swift, cobol' }, fixture.conn);
    expect(out).toContain('Target needs 1 skill: swift');
    expect(out).toContain('(not in the taxonomy, ignored: cobol)');
    expect(out).toContain('Gaps — nobody covers: swift');
    expect(out).toContain('No contact matches any of the required skills yet');
  });

  it('explains an empty target instead of scanning', async () => {
    const out = await executeSkillsGap({ description: 'we need a nice person' }, fixture.conn);
    expect(out).toContain('No taxonomy skills recognised in the target');
  });

  it('compares one contact when --contact is given, treating stored skills as claims', async () => {
    const out = await executeSkillsGap({ contact: 'Cy Fields', skills: 'rust, figma, kubernetes' }, fixture.conn);
    expect(out).toContain('Cy Fields: 67% match (2/3 required)');
    expect(out).toContain('Present: rust, figma');
    expect(out).toContain('Missing: kubernetes');

    const json = JSON.parse(
      await executeSkillsGap({ contact: 'a', skills: 'javascript', json: true }, fixture.conn),
    ) as { gap: { matchScore: number; missing: string[] } };
    expect(json.gap).toMatchObject({ matchScore: 0, missing: ['javascript'] });
  });

  it('caps --limit and rejects nonsense values', async () => {
    await expect(executeSkillsGap({ skills: 'python', limit: '0' }, fixture.conn)).rejects.toThrow(/--limit/);
    const json = JSON.parse(await executeSkillsGap({ skills: 'python', limit: '1', json: true }, fixture.conn)) as {
      candidates: unknown[];
    };
    expect(json.candidates).toHaveLength(1);
  });
});

describe('netpro skills extract / status', () => {
  it('previews with --dry-run, then persists and refreshes the search index', async () => {
    const before = await executeSkillsStatus({}, fixture.conn);
    expect(before).toContain('Contacts: 3 · with skills: 1 · never extracted: 2');
    expect(before).toContain('netpro skills extract');

    const dry = await executeSkillsExtract({ dryRun: true }, fixture.conn, now);
    expect(dry).toContain('Dry run — scanned 3 contacts (heuristic): would update 3');
    expect(dry).toContain('Ada Lovelace: ∅ → python, aws, kubernetes');
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM enrichments").get()).toEqual({ n: 0 });

    const real = await executeSkillsExtract({}, fixture.conn, now);
    expect(real).toContain('scanned 3 contacts (heuristic): updated 3, unchanged 0, with skills 3');
    expect(real).toContain('Search index refreshed for 3 contacts.');
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM enrichments WHERE provider = 'skills_heuristic'").get()).toEqual({ n: 3 });
    expect(
      fixture.sqlite.prepare('SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?').all('kubernetes'),
    ).toEqual([{ contact_id: 'a' }]);

    const after = JSON.parse(await executeSkillsStatus({ json: true }, fixture.conn)) as Record<string, number>;
    expect(after).toEqual({ contacts: 3, withSkills: 3, neverExtracted: 0 });

    const again = await executeSkillsExtract({}, fixture.conn, now);
    expect(again).toContain('updated 0, unchanged 3');
  });

  it('scopes to one contact and honours --limit', async () => {
    const one = JSON.parse(await executeSkillsExtract({ contact: 'Bob Builder', json: true }, fixture.conn, now)) as {
      scanned: number;
      changes: Array<{ contactId: string }>;
    };
    expect(one.scanned).toBe(1);
    expect(one.changes[0]!.contactId).toBe('b');

    const limited = JSON.parse(await executeSkillsExtract({ limit: '1', dryRun: true, json: true }, fixture.conn, now)) as {
      scanned: number;
    };
    expect(limited.scanned).toBe(1);
    await expect(executeSkillsExtract({ limit: 'many' }, fixture.conn, now)).rejects.toThrow(/--limit/);
  });

  it('refuses --mode ai without a configured key, before touching the database', async () => {
    await expect(executeSkillsExtract({ mode: 'ai' }, fixture.conn, now)).rejects.toThrow(/No AI provider key configured/);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM enrichments").get()).toEqual({ n: 0 });
    await expect(executeSkillsExtract({ mode: 'llm' }, fixture.conn, now)).rejects.toThrow(/Unknown --mode/);
  });
});

describe('renderers', () => {
  it('summarises an AI failure without hiding the heuristic result', () => {
    const text = renderExtractSummary({
      scanned: 2,
      updated: 1,
      unchanged: 1,
      withSkills: 2,
      mode: 'ai',
      aiErrors: [{ contactId: 'a', error: 'rate limited' }],
      dryRun: false,
      changes: [{ contactId: 'a', fullName: 'Ada', before: [], after: ['python'] }],
    });
    expect(text).toContain('scanned 2 contacts (ai): updated 1, unchanged 1, with skills 2');
    expect(text).toContain('Ada: ∅ → python');
    expect(text).toContain('AI pass failed for 1 contact (heuristics still applied): rate limited');
  });

  it('renders an empty network honestly', () => {
    const text = renderNetworkGaps({
      target: { required: ['python'], unrecognized: [] },
      required: ['python'],
      contactCount: 0,
      coverage: [{ skill: 'python', contacts: [], count: 0, partialCount: 0 }],
      gaps: ['python'],
      coveredCount: 0,
      candidates: [],
    });
    expect(text).toContain('Network: 0 contacts scanned · 0/1 skills covered');
    expect(text).toContain('Gaps — nobody covers: python');
  });
});
