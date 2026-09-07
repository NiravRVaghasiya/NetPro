// v2.0 Phase 5 — offline-first skills extraction and gap analysis.
// The taxonomy is deliberately bounded and explainable: no network call is
// needed, and callers can add an AI extractor later without changing results.
import { eq, isNull } from 'drizzle-orm';
import type { PgConn, SqliteConn } from '@netpro/db';

export const SKILL_TAXONOMY = [
  'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'c++', 'c#', 'ruby',
  'sql', 'graphql', 'react', 'next.js', 'node.js', 'frontend', 'backend',
  'full stack', 'mobile', 'ios', 'android', 'aws', 'azure', 'gcp', 'docker',
  'kubernetes', 'terraform', 'devops', 'ci/cd', 'machine learning', 'data science',
  'data engineering', 'analytics', 'product management', 'project management',
  'engineering management', 'ux design', 'ui design', 'sales', 'marketing',
  'growth', 'fundraising', 'finance', 'legal', 'security', 'cybersecurity',
] as const;
export type Skill = (typeof SKILL_TAXONOMY)[number];

export interface SkillContact {
  id: string;
  fullName: string;
  email?: string | null;
  headline?: string | null;
  role?: string | null;
  notes?: string | null;
  tags?: unknown;
  customFields?: unknown;
  skills?: unknown;
}

export interface SkillExtraction { skills: Skill[]; evidence: Record<string, string[]>; }
export interface GapResult {
  present: Skill[]; missing: Skill[]; partial: Skill[]; matchScore: number;
}
export interface NetworkGap {
  skill: Skill; contacts: Array<{ id: string; fullName: string }>; count: number;
}

const aliases: Record<Skill, string[]> = Object.fromEntries(
  SKILL_TAXONOMY.map((skill) => [skill, [skill]])
) as Record<Skill, string[]>;
Object.assign(aliases, {
  typescript: ['typescript', 'ts'], javascript: ['javascript', 'js', 'ecmascript'],
  'node.js': ['node.js', 'nodejs', 'node'], 'next.js': ['next.js', 'nextjs'],
  'c++': ['c++', 'cpp'], 'c#': ['c#', 'csharp'], 'ci/cd': ['ci/cd', 'continuous integration', 'continuous delivery'],
  'machine learning': ['machine learning', 'ml'], 'data engineering': ['data engineering', 'data engineer'],
  'full stack': ['full stack', 'full-stack', 'fullstack'], 'ux design': ['ux', 'user experience'],
  'ui design': ['ui', 'user interface'], cybersecurity: ['cybersecurity', 'cyber security'],
});

function textOf(contact: SkillContact): string {
  const values = [contact.headline, contact.role, contact.notes, contact.tags, contact.customFields, contact.skills];
  return values.map((v) => typeof v === 'string' ? v : JSON.stringify(v ?? '')).join(' ').toLowerCase();
}
function storedSkills(value: unknown): Skill[] {
  if (!value) return [];
  let parsed: unknown = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = value.split(/[,;|]/); } }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase()).filter((x): x is Skill => (SKILL_TAXONOMY as readonly string[]).includes(x));
}

export function extractSkills(contact: SkillContact): SkillExtraction {
  const text = textOf(contact);
  const found = new Set<Skill>(storedSkills(contact.skills));
  const evidence: Record<string, string[]> = {};
  for (const skill of SKILL_TAXONOMY) {
    const hits = aliases[skill].filter((alias) => new RegExp(`(^|[^a-z0-9+#])${alias.replace(/[.+]/g, '\\$&')}(?=$|[^a-z0-9+#])`, 'i').test(text));
    if (hits.length) { found.add(skill); evidence[skill] = hits; }
  }
  return { skills: [...found].sort(), evidence };
}

function targetSkills(target: { role?: string; skills?: string[]; description?: string }): Skill[] {
  const extracted = extractSkills({ id: '', fullName: '', role: target.role, notes: target.description, skills: target.skills });
  return extracted.skills;
}

export function gapAnalysis(target: { role?: string; skills?: string[]; description?: string }, candidateSkills: Iterable<string>): GapResult {
  const required = targetSkills(target);
  const candidate = new Set([...candidateSkills].map((s) => s.toLowerCase()));
  const present = required.filter((s) => candidate.has(s));
  // A partial match is a related broad skill (backend covers full stack, etc.).
  const partial = required.filter((s) => !candidate.has(s) && ((s === 'full stack' && candidate.has('frontend') && candidate.has('backend')) || (s === 'cybersecurity' && candidate.has('security'))));
  const missing = required.filter((s) => !present.includes(s) && !partial.includes(s));
  return { present, missing, partial, matchScore: required.length ? (present.length + partial.length * 0.5) / required.length : 0 };
}

export function analyzeNetworkGaps(target: { role?: string; skills?: string[]; description?: string }, contacts: SkillContact[]): { required: Skill[]; gaps: NetworkGap[]; contactCount: number } {
  const required = targetSkills(target);
  const gaps = required.map((skill) => {
    const matches = contacts.filter((contact) => extractSkills(contact).skills.includes(skill)).map((c) => ({ id: c.id, fullName: c.fullName }));
    return { skill, contacts: matches, count: matches.length };
  }).sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
  return { required, gaps, contactCount: contacts.length };
}

/** Persist only the derived verdict; source notes and imported fields are untouched. */
export async function writeExtractedSkills(conn: SqliteConn | PgConn, contactId: string, extraction: SkillExtraction): Promise<void> {
  if (conn.dialect === 'sqlite') {
    await conn.db.update(conn.schema.contacts).set({ skills: extraction.skills }).where(eq(conn.schema.contacts.id, contactId));
  } else {
    await conn.db.update(conn.schema.contacts).set({ skills: JSON.stringify(extraction.skills) }).where(eq(conn.schema.contacts.id, contactId));
  }
}

/** Read live contacts without making skills analysis depend on a dialect-specific query. */
export async function loadSkillContacts(conn: SqliteConn | PgConn): Promise<SkillContact[]> {
  if (conn.dialect === 'sqlite') {
    const rows = await conn.db.select().from(conn.schema.contacts).where(isNull(conn.schema.contacts.deletedAt));
    return rows.map((row: typeof rows[number]) => row as unknown as SkillContact);
  }
  const rows = await conn.db.select().from(conn.schema.contacts).where(isNull(conn.schema.contacts.deletedAt));
  return rows.map((row: typeof rows[number]) => row as unknown as SkillContact);
}

