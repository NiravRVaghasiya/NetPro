// packages/core/src/search/explain.ts
//
// Phase 12 — match explanations: WHY a contact matched, in the owner's words.
//
// `explainMatch` is pure: given a result row and the options that produced
// it, it attributes each free-text term to the field(s) it matched and cites
// each structured filter the row satisfies. Every surface (the server's
// `/api/search`, `netpro search --explain`, the web result cards) renders
// these lines verbatim — no surface invents its own attribution, so the CLI
// and the Web UI always agree on why Sarah Chen matched.
//
// Contract: `options` must be the options the row was fetched with. Filter
// reasons are cited by construction (the row matched, so it satisfies them)
// but verified against the row wherever the row carries the data — a reason
// is never emitted for a condition the row visibly fails. A browse-all query
// (no terms, no filters) yields no reasons: there is nothing to explain.
import { canonicalSkill } from "../skills/taxonomy";
import type { ContactSearchResult, SearchContactsOptions } from "./types";

export type MatchReasonKind =
  | "name"
  | "email"
  | "headline"
  | "company"
  | "role"
  | "location"
  | "industry"
  | "seniority"
  | "skill"
  | "tag"
  | "score"
  | "recency"
  | "community"
  /** A term the lexical fields cannot account for (keyword/semantic arm hit). */
  | "query";

export interface MatchReason {
  /** Stable machine-readable kind for styling and tests. */
  kind: MatchReasonKind;
  /** Human-readable line, e.g. `Works at Acme`. */
  text: string;
}

function splitTerms(query: string | undefined): string[] {
  return (query ?? "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

type TermFieldKey =
  | "fullName"
  | "email"
  | "headline"
  | "company"
  | "role"
  | "location";

/**
 * Field attribution for one free-text term, in display-priority order. The
 * keys mirror SEARCHABLE_COLUMNS in conditions.ts (the six columns the SQL
 * actually tests); the phrasing is the plan's ("Works at Acme") where a field
 * has a natural sentence, and `Field matches "term"` elsewhere.
 */
const TERM_FIELDS: Array<{
  key: TermFieldKey;
  kind: MatchReasonKind;
  describe: (term: string, value: string) => string;
}> = [
  { key: "fullName", kind: "name", describe: (t) => `Name matches "${t}"` },
  { key: "email", kind: "email", describe: (t) => `Email matches "${t}"` },
  { key: "company", kind: "company", describe: (_t, v) => `Works at ${v}` },
  { key: "role", kind: "role", describe: (_t, v) => `Works as ${v}` },
  {
    key: "headline",
    kind: "headline",
    describe: (t) => `Headline matches "${t}"`,
  },
  { key: "location", kind: "location", describe: (_t, v) => `Based in ${v}` },
];

function contains(haystack: string | null, needle: string): boolean {
  return (
    haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase())
  );
}

/**
 * Explain why one contact matched a search. Deterministic: same row +
 * options always yields the same lines in the same order (term attribution
 * first, then one line per satisfied structured filter, deduplicated).
 */
export function explainMatch(
  contact: ContactSearchResult,
  options: SearchContactsOptions = {},
): MatchReason[] {
  const reasons: MatchReason[] = [];
  const seen = new Set<string>();
  const push = (kind: MatchReasonKind, text: string): void => {
    if (!seen.has(text)) {
      seen.add(text);
      reasons.push({ kind, text });
    }
  };

  // ── Free-text attribution ──────────────────────────────────────────
  // Every portable term matched at least one field (AND semantics); a hybrid
  // arm can additionally surface rows no substring explains (stemming,
  // semantic similarity) — those terms get an honest `Related to` fallback
  // rather than a fabricated field or silence.
  for (const term of splitTerms(options.query)) {
    let attributed = false;
    for (const field of TERM_FIELDS) {
      const value = contact[field.key];
      if (value !== null && contains(value, term)) {
        push(field.kind, field.describe(term, value));
        attributed = true;
      }
    }
    if (!attributed) {
      push("query", `Related to "${term}"`);
    }
  }

  // ── Structured filters (verified against the row) ──────────────────
  if (options.name && contains(contact.fullName, options.name)) {
    push("name", `Name contains "${options.name.trim()}"`);
  }
  if (options.company && contains(contact.company, options.company)) {
    push("company", `Works at ${contact.company}`);
  }
  if (options.role && contains(contact.role, options.role)) {
    push("role", `Works as ${contact.role}`);
  }
  if (options.location && contains(contact.location, options.location)) {
    push("location", `Based in ${contact.location}`);
  }
  if (options.industry && contains(contact.industry, options.industry)) {
    push("industry", `Works in ${contact.industry}`);
  }
  if (
    options.seniority &&
    contact.seniority !== null &&
    contact.seniority === options.seniority
  ) {
    push("seniority", `Seniority: ${contact.seniority}`);
  }
  if (
    options.hasEmail &&
    contact.email !== null &&
    contact.email.trim() !== ""
  ) {
    push("email", "Has email address");
  }
  if (
    typeof options.minScore === "number" &&
    contact.relationshipScore !== null &&
    contact.relationshipScore >= options.minScore
  ) {
    push(
      "score",
      `Relationship strength ${contact.relationshipScore.toFixed(2)} (minimum ${options.minScore})`,
    );
  }
  if (
    typeof options.lastActiveWithinDays === "number" &&
    options.lastActiveWithinDays > 0 &&
    contact.lastInteraction !== null &&
    contact.lastInteraction >=
      new Date(
        Date.now() - options.lastActiveWithinDays * 24 * 60 * 60 * 1000,
      ).toISOString()
  ) {
    const n = options.lastActiveWithinDays;
    push("recency", `Active within the last ${n} day${n === 1 ? "" : "s"}`);
  }
  for (const raw of options.skills ?? []) {
    const skill = canonicalSkill(raw);
    if (skill && contact.skills?.includes(skill)) {
      push("skill", `Has skill: ${skill}`);
    }
  }
  const tags = contact.tags ?? [];
  for (const raw of options.tags ?? []) {
    const needle = raw.trim().toLowerCase();
    if (!needle) continue;
    const actual = tags.find((t) => t.toLowerCase() === needle);
    if (actual) {
      push("tag", `Tagged "${actual}"`);
    }
  }
  // Community membership is graph-computed, not row-carried, so it cannot be
  // re-verified here — it is cited by construction (the row passed the
  // community id-set the query resolved).
  if (options.community?.trim()) {
    push("community", `In community "${options.community.trim()}"`);
  }

  return reasons;
}
