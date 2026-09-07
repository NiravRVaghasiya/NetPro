// packages/core/src/skills/extract.ts
//
// v2.0 Phase 5 — skill extraction.
//
// Two extractors, one contract:
//   * `extractSkills(contact)` — the heuristic pass. Scans the contact's
//     headline, role, department, industry, notes, tags and custom fields for
//     taxonomy names/aliases as whole tokens (n-grams up to the longest
//     alias), and records *where* each skill was found. Offline, deterministic,
//     free. Runs everywhere by default.
//   * `extractSkillsWithAi(contact, { provider })` — the optional AI pass. The
//     model is shown the same text and the taxonomy, and may only CHOOSE from
//     the taxonomy; anything it invents is dropped. Its picks are merged with
//     the heuristics, tagged `source: 'ai'`, and assigned a lower confidence.
//     Requires a BYO key, never runs unless asked (`--mode ai`).
//
// Evidence is the product, not a by-product: a skill on a contact page should
// be one click away from the sentence that earned it, because a wrong skill
// persisted onto a person is the failure mode this module is designed around.

import type { AiProvider, ChatMessage } from '../ai/types';
import { AiProviderError } from '../ai/types';
import {
  aliasSpanFrom,
  MAX_ALIAS_WORDS,
  SKILL_TAXONOMY,
  canonicalSkill,
  lookupAlias,
  normalizeMatchText,
  skillCategory,
  type Skill,
  type SkillCategory,
} from './taxonomy';

/** The contact fields extraction reads. Everything optional except identity. */
export interface SkillContact {
  id: string;
  fullName: string;
  email?: string | null;
  headline?: string | null;
  role?: string | null;
  department?: string | null;
  industry?: string | null;
  notes?: string | null;
  /** JSON array (SQLite json mode) or JSON string (Postgres text). */
  tags?: unknown;
  customFields?: unknown;
  /** Previously persisted verdict — same encodings as `tags`. */
  skills?: unknown;
}

export type SkillSource = 'heuristic' | 'ai' | 'stored';

/** Which contact field a skill was found in (`tags`/`customFields` are explicit signals). */
export type SkillEvidenceField =
  | 'headline'
  | 'role'
  | 'department'
  | 'industry'
  | 'notes'
  | 'tags'
  | 'customFields';

export interface SkillEvidence {
  field: SkillEvidenceField;
  /** The alias that matched, as it appears in the taxonomy (e.g. `k8s`). */
  matched: string;
  /** A short window of the original text around the match. */
  snippet: string;
}

export interface ExtractedSkill {
  skill: Skill;
  category: SkillCategory;
  /** 0–1. Heuristic hits are 1 in explicit fields, 0.9 in prose; AI picks 0.6. */
  confidence: number;
  source: SkillSource;
  evidence: SkillEvidence[];
}

export interface SkillExtraction {
  /** Canonical skill names, taxonomy order. */
  skills: Skill[];
  details: ExtractedSkill[];
  /** Evidence keyed by skill — the shape the surfaces render. */
  evidence: Record<string, SkillEvidence[]>;
  mode: 'heuristic' | 'ai';
  /** Set when an AI pass was requested and failed; heuristics still applied. */
  aiError?: string;
}

/** Bound on the text one extraction scans — a pathological notes blob is truncated, not fatal. */
export const MAX_EXTRACT_CHARS = 20_000;

const SNIPPET_RADIUS = 40;

const FIELD_ORDER: SkillEvidenceField[] = [
  'headline',
  'role',
  'department',
  'industry',
  'tags',
  'customFields',
  'notes',
];

/** Tags/customFields may be a JSON array, an object, a JSON string, or a delimited string. */
export function listValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed.split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? listValues(v) : []));
  }
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed as Record<string, unknown>).flatMap(listValues);
  }
  return typeof parsed === 'string' ? [parsed] : [];
}

/** Stored verdict → canonical skills (unknown/legacy entries are dropped silently). */
export function storedSkills(value: unknown): Skill[] {
  const out: Skill[] = [];
  for (const raw of listValues(value)) {
    const skill = canonicalSkill(raw);
    if (skill && !out.includes(skill)) out.push(skill);
  }
  return sortSkills(out);
}

export function sortSkills(skills: Iterable<Skill>): Skill[] {
  const set = new Set(skills);
  return SKILL_TAXONOMY.filter((s) => set.has(s));
}

interface FieldText {
  field: SkillEvidenceField;
  text: string;
  /** Explicit fields (tags, custom fields) are matched permissively — a tag `go` means Go. */
  explicit: boolean;
}

function fieldTexts(contact: SkillContact): FieldText[] {
  const out: FieldText[] = [];
  const push = (field: SkillEvidenceField, text: string | null | undefined, explicit = false) => {
    if (typeof text === 'string' && text.trim()) out.push({ field, text: text.slice(0, MAX_EXTRACT_CHARS), explicit });
  };
  push('headline', contact.headline);
  push('role', contact.role);
  push('department', contact.department);
  push('industry', contact.industry);
  const tags = listValues(contact.tags);
  if (tags.length) push('tags', tags.join(', '), true);
  const custom = listValues(contact.customFields);
  if (custom.length) push('customFields', custom.join(', '), true);
  push('notes', contact.notes);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locate a normalised n-gram in the original text (separators may differ: `co-founder` vs `co founder`). */
function snippetAround(text: string, gram: string): string {
  const pattern = new RegExp(gram.split(' ').map(escapeRegExp).join('[^a-z0-9+#&.]+'), 'i');
  const match = pattern.exec(text);
  const idx = match ? match.index : text.toLowerCase().indexOf(gram);
  const length = match ? match[0].length : gram.length;
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Scan one field: whole-token n-gram matching against the alias table. Explicit
 * fields (tags) are matched per value and permissively; prose is matched with
 * the ambiguous bare names excluded.
 */
function scanField(f: FieldText): Map<Skill, SkillEvidence> {
  const found = new Map<Skill, SkillEvidence>();
  if (f.explicit) {
    // Each tag is a claim in itself: `go`, `swift`, `excel` as a tag means the skill.
    for (const value of f.text.split(/[,;|\n]/)) {
      const skill = canonicalSkill(value);
      if (skill && !found.has(skill)) {
        found.set(skill, { field: f.field, matched: value.trim().toLowerCase(), snippet: value.trim() });
      }
    }
    // A tag like "Kubernetes & Terraform" still deserves the n-gram scan (permissive).
    scanTokens(f, found, true);
    return found;
  }
  scanTokens(f, found, false);
  return found;
}

/**
 * Longest-match n-gram scan. At each offset the longest alias wins and its
 * tokens are consumed, so "react native" never also yields "react" and
 * "engineering manager" never also yields "manager"-anything.
 */
export function scanForSkills(text: string, permissive: boolean): Array<{ skill: Skill; gram: string }> {
  const tokens = normalizeMatchText(text).split(' ').filter(Boolean);
  const hits: Array<{ skill: Skill; gram: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    let consumed = 1;
    // Only tokens that begin some alias are worth an n-gram at all.
    const span = Math.min(aliasSpanFrom(tokens[i]!), MAX_ALIAS_WORDS, tokens.length - i);
    for (let n = span; n >= 1; n--) {
      const gram = n === 1 ? tokens[i]! : tokens.slice(i, i + n).join(' ');
      const skill = lookupAlias(gram, permissive);
      if (skill) {
        hits.push({ skill, gram });
        consumed = n;
        break;
      }
    }
    i += consumed;
  }
  return hits;
}

function scanTokens(f: FieldText, found: Map<Skill, SkillEvidence>, permissive: boolean): void {
  for (const { skill, gram } of scanForSkills(f.text, permissive)) {
    if (!found.has(skill)) {
      found.set(skill, { field: f.field, matched: gram, snippet: snippetAround(f.text, gram) });
    }
  }
}

/**
 * Heuristic extraction: taxonomy skills found in the contact's own fields,
 * with per-skill evidence. Never touches the network.
 */
export function extractSkills(contact: SkillContact): SkillExtraction {
  const details = new Map<Skill, ExtractedSkill>();
  for (const field of fieldTexts(contact).sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))) {
    for (const [skill, ev] of scanField(field)) {
      const existing = details.get(skill);
      const confidence = field.explicit || field.field !== 'notes' ? 1 : 0.9;
      if (existing) {
        existing.evidence.push(ev);
        existing.confidence = Math.max(existing.confidence, confidence);
      } else {
        details.set(skill, { skill, category: skillCategory(skill), confidence, source: 'heuristic', evidence: [ev] });
      }
    }
  }
  // A previously stored verdict counts, but only as `stored` — it is the
  // owner's (or an earlier run's) claim, and it should never outrank fresh
  // evidence from the text or hide that the text no longer supports it.
  for (const skill of storedSkills(contact.skills)) {
    if (!details.has(skill)) {
      details.set(skill, { skill, category: skillCategory(skill), confidence: 0.8, source: 'stored', evidence: [] });
    }
  }
  return finish([...details.values()], 'heuristic');
}

function finish(list: ExtractedSkill[], mode: SkillExtraction['mode'], aiError?: string): SkillExtraction {
  const ordered = sortSkills(list.map((d) => d.skill));
  const byName = new Map(list.map((d) => [d.skill, d]));
  const details = ordered.map((s) => byName.get(s)!);
  const evidence: Record<string, SkillEvidence[]> = {};
  for (const d of details) evidence[d.skill] = d.evidence;
  return { skills: ordered, details, evidence, mode, ...(aiError ? { aiError } : {}) };
}

// ── AI pass ─────────────────────────────────────────────────────────────────

export const AI_SKILL_CONFIDENCE = 0.6;
/** Hard cap on skills accepted from the model — a list longer than this is noise, not insight. */
export const AI_MAX_SKILLS = 25;

export interface AiExtractOptions {
  provider: AiProvider;
  model?: string;
  signal?: AbortSignal;
}

/** The prompt is exported so tests can pin its contract (taxonomy-only, JSON array out). */
export function buildSkillExtractionMessages(contact: SkillContact): ChatMessage[] {
  const facts = fieldTexts(contact).map((f) => `- ${f.field}: ${f.text}`);
  return [
    {
      role: 'system',
      content:
        'You classify professional skills. You are given text about one person and a fixed list of ' +
        'allowed skill names. Reply with ONLY a JSON array of strings, each string copied exactly from ' +
        'the allowed list, for skills the text clearly supports. Do not invent skills, do not infer from ' +
        'the company name alone, and reply with [] when nothing is supported.',
    },
    {
      role: 'user',
      content:
        `Allowed skills:\n${SKILL_TAXONOMY.join(', ')}\n\n` +
        `Person:\n${facts.length ? facts.join('\n') : '- (no profile text)'}\n\n` +
        'JSON array of allowed skill names:',
    },
  ];
}

/** Parse the model reply: a JSON array (bare or fenced), else a comma/newline list. Unknown names are dropped. */
export function parseSkillReply(raw: string): Skill[] {
  const text = raw.trim();
  const candidates: unknown[] = [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) candidates.push(...parsed);
    } catch {
      // fall through to the delimited form
    }
  }
  if (candidates.length === 0) {
    candidates.push(...text.replace(/```(?:json)?/gi, '').split(/[,\n]/));
  }
  const out: Skill[] = [];
  for (const c of candidates) {
    const skill = canonicalSkill(typeof c === 'string' ? c.replace(/^["'\s\-•*]+|["'\s]+$/g, '') : c);
    if (skill && !out.includes(skill)) out.push(skill);
    if (out.length >= AI_MAX_SKILLS) break;
  }
  return sortSkills(out);
}

/**
 * Heuristics + an AI pass. The AI may only add taxonomy skills the heuristics
 * missed; a provider failure is reported in `aiError` and the heuristic result
 * is returned intact — the offline path is the guarantee, the model the bonus.
 */
export async function extractSkillsWithAi(
  contact: SkillContact,
  opts: AiExtractOptions,
): Promise<SkillExtraction> {
  const base = extractSkills(contact);
  if (fieldTexts(contact).length === 0) return { ...base, mode: 'ai' };
  let picks: Skill[];
  try {
    const raw = await opts.provider.complete(buildSkillExtractionMessages(contact), {
      model: opts.model,
      temperature: 0,
      maxTokens: 300,
      signal: opts.signal,
    });
    picks = parseSkillReply(raw);
  } catch (e) {
    const message = e instanceof AiProviderError ? `${e.code}: ${e.message}` : (e as Error).message;
    return finish(base.details, 'ai', message);
  }
  const merged = [...base.details];
  for (const skill of picks) {
    if (merged.some((d) => d.skill === skill)) continue;
    merged.push({ skill, category: skillCategory(skill), confidence: AI_SKILL_CONFIDENCE, source: 'ai', evidence: [] });
  }
  return finish(merged, 'ai');
}
