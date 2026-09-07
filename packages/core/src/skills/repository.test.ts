import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import type { AiProvider } from '../ai/types';
import { extractSkills } from './extract';
import {
  SKILLS_PROVIDER_AI,
  SKILLS_PROVIDER_HEURISTIC,
  extractSkillsBatch,
  getSkillContact,
  getSkillsEvidence,
  getSkillsProfile,
  loadSkillContacts,
  skillsStatus,
  writeExtractedSkills,
} from './repository';

const fixture = createTestSqliteConn();
const { conn, sqlite } = fixture;
const NOW = new Date('2026-09-07T12:00:00.000Z');

function seed(rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    conn.db
      .insert(conn.schema.contacts)
      .values({
        source: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...(r as { id: string; fullName: string }),
      })
      .run();
  }
}

beforeEach(() => {
  sqlite.exec('DELETE FROM enrichments; DELETE FROM activity_log; DELETE FROM contacts;');
  seed([
    { id: 'a', fullName: 'Ada', headline: 'Staff TypeScript engineer, Kubernetes', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob', notes: 'Python & SQL', tags: ['aws'], relationshipScore: 0.4 },
    { id: 'c', fullName: 'Cy', headline: 'Product designer (Figma)', skills: ['rust', 'figma'] },
    { id: 'gone', fullName: 'Ghost', headline: 'Rust', deletedAt: NOW.toISOString() },
  ]);
});
afterAll(() => sqlite.close());

describe('loadSkillContacts / getSkillContact', () => {
  it('returns live contacts only, ordered by id, with the fields extraction needs', async () => {
    const rows = await loadSkillContacts(conn);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    // Raw ANSI read: json-mode columns arrive as stored text; extraction parses them.
    expect(rows[1]).toMatchObject({ fullName: 'Bob', notes: 'Python & SQL', tags: '["aws"]', relationshipScore: 0.4 });
    expect(await getSkillContact(conn, 'gone')).toBeNull();
    expect(await getSkillContact(conn, ' a ')).toMatchObject({ id: 'a' });
    expect(await loadSkillContacts(conn, { ids: [] })).toEqual([]);
    expect((await loadSkillContacts(conn, { ids: ['b', 'nope'] })).map((r) => r.id)).toEqual(['b']);
  });
});

describe('writeExtractedSkills', () => {
  it('stores the verdict on the contact and the evidence in enrichments; source fields untouched', async () => {
    const contact = (await getSkillContact(conn, 'a'))!;
    const extraction = extractSkills(contact);
    const result = await writeExtractedSkills(conn, 'a', extraction, { now: NOW });
    expect(result).toEqual({ contactId: 'a', skills: ['typescript', 'kubernetes'], changed: true });

    const row = sqlite.prepare('SELECT skills, headline, updated_at FROM contacts WHERE id = ?').get('a') as {
      skills: string;
      headline: string;
      updated_at: string;
    };
    expect(JSON.parse(row.skills)).toEqual(['typescript', 'kubernetes']);
    expect(row.headline).toBe('Staff TypeScript engineer, Kubernetes');
    expect(row.updated_at).toBe(NOW.toISOString());

    const evidence = await getSkillsEvidence(conn, 'a');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ provider: SKILLS_PROVIDER_HEURISTIC, fetchedAt: NOW.toISOString(), confidence: 1 });
    expect(evidence[0]!.payload.skills).toEqual(['typescript', 'kubernetes']);
    expect(evidence[0]!.payload.details[0]!.evidence[0]).toMatchObject({ field: 'headline', matched: 'typescript' });

    const log = sqlite.prepare("SELECT action, entity_id, metadata FROM activity_log WHERE action = 'skills.extracted'").all() as Array<{
      entity_id: string;
      metadata: string;
    }>;
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!.metadata)).toMatchObject({ mode: 'heuristic', before: [], skills: ['typescript', 'kubernetes'] });
  });

  it('is idempotent: an unchanged verdict rewrites nothing on the contact but refreshes the evidence row', async () => {
    const contact = (await getSkillContact(conn, 'a'))!;
    await writeExtractedSkills(conn, 'a', extractSkills(contact), { now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const again = await writeExtractedSkills(conn, 'a', extractSkills(contact), { now: later });
    expect(again.changed).toBe(false);
    const row = sqlite.prepare('SELECT updated_at FROM contacts WHERE id = ?').get('a') as { updated_at: string };
    expect(row.updated_at).toBe(NOW.toISOString());
    const evidence = await getSkillsEvidence(conn, 'a');
    expect(evidence).toHaveLength(1); // replaced, not appended
    expect(evidence[0]!.fetchedAt).toBe(later.toISOString());
    expect(sqlite.prepare("SELECT count(*) AS n FROM activity_log WHERE action = 'skills.extracted'").get()).toEqual({ n: 1 });
  });

  it('keeps heuristic and ai evidence as separate rows', async () => {
    const contact = (await getSkillContact(conn, 'a'))!;
    await writeExtractedSkills(conn, 'a', extractSkills(contact), { now: NOW });
    await writeExtractedSkills(conn, 'a', { ...extractSkills(contact), mode: 'ai' }, { now: new Date(NOW.getTime() + 1) });
    const evidence = await getSkillsEvidence(conn, 'a');
    expect(evidence.map((e) => e.provider)).toEqual([SKILLS_PROVIDER_AI, SKILLS_PROVIDER_HEURISTIC]);
  });
});

describe('getSkillsProfile', () => {
  it('reports stored vs current and flags stored skills the text no longer supports', async () => {
    const profile = (await getSkillsProfile(conn, 'c'))!;
    expect(profile.stored).toEqual(['rust', 'figma']); // taxonomy order, not stored order
    expect(profile.current.skills).toEqual(['product design', 'figma']);
    expect(profile.unsupported).toEqual(['rust']);
    expect(profile.evidence).toEqual([]);
    expect(await getSkillsProfile(conn, 'gone')).toBeNull();
  });
});

describe('extractSkillsBatch', () => {
  it('extracts every live contact heuristically, persists, and reports changes', async () => {
    const summary = await extractSkillsBatch(conn, { now: NOW });
    expect(summary).toMatchObject({ scanned: 3, updated: 3, unchanged: 0, withSkills: 3, mode: 'heuristic', dryRun: false, aiErrors: [] });
    expect(summary.changes.map((c) => [c.contactId, c.after])).toEqual([
      ['a', ['typescript', 'kubernetes']],
      ['b', ['python', 'sql', 'aws']],
      ['c', ['product design', 'figma']],
    ]);
    // Cy's stored `rust` was not supported by the text and is gone after a recompute.
    expect(summary.changes[2]!.before).toEqual(['rust', 'figma']);
    expect(await skillsStatus(conn)).toEqual({ contacts: 3, withSkills: 3, neverExtracted: 0 });
    // Changed verdicts refresh the keyword index so `netpro search kubernetes` finds Ada.
    expect(summary.indexed).toEqual({ indexed: 3, skipped: 0 });
    expect(
      sqlite.prepare('SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?').all('kubernetes'),
    ).toEqual([{ contact_id: 'a' }]);

    const second = await extractSkillsBatch(conn, { now: NOW });
    expect(second).toMatchObject({ scanned: 3, updated: 0, unchanged: 3 });
    expect(second.indexed).toBeUndefined();
  });

  it('dryRun previews without writing; contactIds and limit scope the run', async () => {
    const preview = await extractSkillsBatch(conn, { dryRun: true });
    expect(preview).toMatchObject({ scanned: 3, updated: 3, dryRun: true });
    expect(await skillsStatus(conn)).toEqual({ contacts: 3, withSkills: 1, neverExtracted: 2 });
    expect(sqlite.prepare('SELECT count(*) AS n FROM enrichments').get()).toEqual({ n: 0 });

    const scoped = await extractSkillsBatch(conn, { contactIds: ['b'], now: NOW });
    expect(scoped).toMatchObject({ scanned: 1, updated: 1 });
    expect(await skillsStatus(conn)).toEqual({ contacts: 3, withSkills: 2, neverExtracted: 1 });

    const limited = await extractSkillsBatch(conn, { limit: 1, dryRun: true });
    expect(limited.scanned).toBe(1);
  });

  it('runs the AI pass per contact, recording failures without losing heuristics', async () => {
    let calls = 0;
    const provider: AiProvider = {
      id: 'openai',
      label: 'fake',
      defaultModel: 'fake',
      async complete() {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return '["rust"]';
      },
    };
    const summary = await extractSkillsBatch(conn, { mode: 'ai', provider, now: NOW });
    expect(summary.mode).toBe('ai');
    expect(calls).toBe(3);
    expect(summary.aiErrors).toEqual([{ contactId: 'b', error: 'boom' }]);
    const a = sqlite.prepare('SELECT skills FROM contacts WHERE id = ?').get('a') as { skills: string };
    expect(JSON.parse(a.skills)).toEqual(['typescript', 'rust', 'kubernetes']);
    const b = sqlite.prepare('SELECT skills FROM contacts WHERE id = ?').get('b') as { skills: string };
    expect(JSON.parse(b.skills)).toEqual(['python', 'sql', 'aws']);
    const evidence = await getSkillsEvidence(conn, 'b');
    expect(evidence[0]!.provider).toBe(SKILLS_PROVIDER_AI);
    expect(evidence[0]!.payload.aiError).toBe('boom');
  });

  it('refuses an AI run without a provider', async () => {
    await expect(extractSkillsBatch(conn, { mode: 'ai' })).rejects.toThrow(/no AI provider/);
  });
});
