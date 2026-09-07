// packages/core/src/skills/gap.ts
//
// v2.0 Phase 5 — gap analysis: what a target needs vs. what a person (or the
// whole network) has. Pure functions over `SkillContact[]`; the repository
// module supplies the rows, the surfaces render the result.
//
// The maths is deliberately simple enough to check by hand:
//   matchScore = (present + 0.5 × partial) / required     (2 dp)
// A "partial" is one of the legible rules in `PARTIAL_COVERAGE` (frontend +
// backend ⇒ full stack, aws ⇒ cloud, …) — never a learned similarity.

import { extractSkills, scanForSkills, sortSkills, type SkillContact, type SkillExtraction } from './extract';
import { PARTIAL_COVERAGE, canonicalSkill, type Skill } from './taxonomy';

/** The target to analyse against. At least one of the three should be given. */
export interface SkillTarget {
  /** Role title, e.g. "Staff Engineer" (scanned for taxonomy skills). */
  role?: string | null;
  /** Free-text job description or requirement list. */
  description?: string | null;
  /** Explicit skill list; unknown names are reported in `unrecognized`. */
  skills?: readonly string[] | string | null;
}

export interface ParsedTarget {
  required: Skill[];
  /** Explicit `skills` entries that are not in the taxonomy. */
  unrecognized: string[];
}

/** Tokens in the target that are never skills, so "senior", "staff", "engineer" don't produce noise. */
const MAX_TARGET_CHARS = 10_000;

/**
 * Turn a target into its required taxonomy skills. Explicit `skills` are
 * matched as values (so `go` counts); role/description are scanned as prose
 * (so "go deep" does not), except that a comma/newline/bullet-separated
 * description is ALSO tried value-by-value — people paste requirement lists.
 */
export function parseTarget(target: SkillTarget): ParsedTarget {
  const required = new Set<Skill>();
  const unrecognized: string[] = [];

  const explicit = Array.isArray(target.skills)
    ? target.skills
    : typeof target.skills === 'string'
      ? target.skills.split(/[,;|\n]/)
      : [];
  for (const raw of explicit) {
    const value = String(raw).trim();
    if (!value) continue;
    const skill = canonicalSkill(value);
    if (skill) required.add(skill);
    else if (!unrecognized.includes(value)) unrecognized.push(value);
  }

  const prose = [target.role, target.description]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.slice(0, MAX_TARGET_CHARS));
  for (const text of prose) {
    // Value-wise pass over list-like segments (permissive), then a prose scan.
    for (const segment of text.split(/[,;|\n•·]/)) {
      const skill = canonicalSkill(segment.replace(/^[\s\-–—*]+/, ''));
      if (skill) required.add(skill);
    }
    for (const { skill } of scanForSkills(text, false)) required.add(skill);
  }

  return { required: sortSkills(required), unrecognized };
}

export interface GapResult {
  required: Skill[];
  present: Skill[];
  /** Required skills covered by an adjacent skill; `partialVia` names the rule. */
  partial: Skill[];
  partialVia: Record<string, Skill[]>;
  missing: Skill[];
  /** (present + 0.5·partial) / required, 2 dp; 0 when nothing is required. */
  matchScore: number;
}

/** Compare one candidate's skills against a target. */
export function gapAnalysis(target: SkillTarget | ParsedTarget, candidateSkills: Iterable<string>): GapResult {
  const required = 'required' in target && Array.isArray((target as ParsedTarget).required)
    ? (target as ParsedTarget).required
    : parseTarget(target as SkillTarget).required;
  const have = new Set<Skill>();
  for (const s of candidateSkills) {
    const skill = canonicalSkill(s);
    if (skill) have.add(skill);
  }

  const present: Skill[] = [];
  const partial: Skill[] = [];
  const partialVia: Record<string, Skill[]> = {};
  const missing: Skill[] = [];
  for (const skill of required) {
    if (have.has(skill)) {
      present.push(skill);
      continue;
    }
    const rule = PARTIAL_COVERAGE[skill];
    const viaAll = rule?.all && rule.all.every((s) => have.has(s)) ? [...rule.all] : [];
    const viaAny = rule?.any ? rule.any.filter((s) => have.has(s)) : [];
    const via = sortSkills([...viaAll, ...viaAny]);
    if (via.length > 0) {
      partial.push(skill);
      partialVia[skill] = via;
    } else {
      missing.push(skill);
    }
  }
  const matchScore = required.length
    ? Math.round(((present.length + 0.5 * partial.length) / required.length) * 100) / 100
    : 0;
  return { required, present, partial, partialVia, missing, matchScore };
}

export interface SkillContactRef {
  id: string;
  fullName: string;
  company?: string | null;
  role?: string | null;
  relationshipScore?: number | null;
}

export interface SkillCoverage {
  skill: Skill;
  /** Contacts with the skill outright, strongest relationship first. */
  contacts: SkillContactRef[];
  count: number;
  /** Contacts covering it only partially (rule-based). */
  partialCount: number;
}

export interface RankedCandidate extends SkillContactRef {
  gap: GapResult;
}

export interface NetworkGapAnalysis {
  target: ParsedTarget;
  required: Skill[];
  contactCount: number;
  /** Per required skill, who has it — sorted by count desc, then taxonomy order. */
  coverage: SkillCoverage[];
  /** Required skills nobody in the network has (even partially). */
  gaps: Skill[];
  /** Required skills at least one contact has outright. */
  coveredCount: number;
  /** Best individual matches (matchScore desc, relationship desc, name). */
  candidates: RankedCandidate[];
}

export interface NetworkGapOptions {
  /** Contacts listed per skill (default 5, max 50). */
  perSkill?: number;
  /** Ranked candidates returned (default 10, max 100). */
  candidates?: number;
  /** Extraction override — lets callers reuse a cached pass. */
  extract?: (contact: SkillContact) => SkillExtraction;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function toRef(c: SkillContact & Partial<SkillContactRef>): SkillContactRef {
  return {
    id: c.id,
    fullName: c.fullName,
    company: c.company ?? null,
    role: c.role ?? null,
    relationshipScore: typeof c.relationshipScore === 'number' ? c.relationshipScore : null,
  };
}

function byStrength(a: SkillContactRef, b: SkillContactRef): number {
  return (b.relationshipScore ?? 0) - (a.relationshipScore ?? 0) || a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id);
}

/**
 * Aggregate the gap analysis across contacts: who fills each required skill,
 * which skills nobody covers, and the best individual matches. Extraction is
 * run once per contact.
 */
export function analyzeNetworkGaps(
  target: SkillTarget,
  contacts: Array<SkillContact & Partial<SkillContactRef>>,
  opts: NetworkGapOptions = {},
): NetworkGapAnalysis {
  const parsed = parseTarget(target);
  const perSkill = clampInt(opts.perSkill, 5, 50);
  const candidateLimit = clampInt(opts.candidates, 10, 100);
  const extract = opts.extract ?? extractSkills;

  const ranked: RankedCandidate[] = [];
  const holders = new Map<Skill, SkillContactRef[]>();
  const partials = new Map<Skill, number>();
  for (const skill of parsed.required) {
    holders.set(skill, []);
    partials.set(skill, 0);
  }

  for (const contact of contacts) {
    const skills = extract(contact).skills;
    const gap = gapAnalysis(parsed, skills);
    const ref = toRef(contact);
    for (const s of gap.present) holders.get(s)!.push(ref);
    for (const s of gap.partial) partials.set(s, (partials.get(s) ?? 0) + 1);
    if (parsed.required.length > 0 && gap.matchScore > 0) ranked.push({ ...ref, gap });
  }

  const coverage: SkillCoverage[] = parsed.required.map((skill) => {
    const all = holders.get(skill)!.sort(byStrength);
    return { skill, contacts: all.slice(0, perSkill), count: all.length, partialCount: partials.get(skill) ?? 0 };
  });
  coverage.sort((a, b) => b.count - a.count || parsed.required.indexOf(a.skill) - parsed.required.indexOf(b.skill));

  ranked.sort((a, b) => b.gap.matchScore - a.gap.matchScore || byStrength(a, b));

  return {
    target: parsed,
    required: parsed.required,
    contactCount: contacts.length,
    coverage,
    gaps: coverage.filter((c) => c.count === 0 && c.partialCount === 0).map((c) => c.skill),
    coveredCount: coverage.filter((c) => c.count > 0).length,
    candidates: ranked.slice(0, candidateLimit),
  };
}

export interface SkillCount {
  skill: Skill;
  count: number;
}

/**
 * The network's skill map: how many contacts carry each taxonomy skill
 * (zero-count skills omitted; `limit` keeps the top N by count).
 */
export function networkSkillCounts(
  contacts: SkillContact[],
  opts: { extract?: (contact: SkillContact) => SkillExtraction; limit?: number } = {},
): { counts: SkillCount[]; contactCount: number; withSkills: number; distinct: number } {
  const extract = opts.extract ?? extractSkills;
  const tally = new Map<Skill, number>();
  let withSkills = 0;
  for (const contact of contacts) {
    const skills = extract(contact).skills;
    if (skills.length > 0) withSkills += 1;
    for (const s of skills) tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  const counts = sortSkills(tally.keys())
    .map((skill) => ({ skill, count: tally.get(skill)! }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : undefined;
  return {
    counts: limit ? counts.slice(0, limit) : counts,
    contactCount: contacts.length,
    withSkills,
    distinct: counts.length,
  };
}
