// packages/core/src/events/match.ts
//
// The pure half of the event matcher: given the attendee list an event
// exported and the contacts you already have, decide — with reasons — which
// person each line is.
//
// No database, no network, no guessing. Three tiers, most trusted first:
//
//   1. email exact (1.0) — normalized, `mailto:` and angle brackets stripped
//   2. name exact (0.9) — accent/punctuation/case-insensitive whole-name match
//   3. last name + first initial (0.6) — `A Lovelace` / `Ada L.`
//
// Tier 3 exists because exports abbreviate (`Ada L.`), but a fuzzy hit is
// never trusted silently: it comes back as `review`, and only `matched`
// (≥ 0.9) rows are written unless the caller opts in. Anything with more than
// one plausible contact is `ambiguous` — the caller shows the candidates and
// the owner picks.
import { AUTO_MATCH_CONFIDENCE, EVENT_LIMITS } from './types';
import type { AttendeeMatch, AttendeeRef, MatchVia } from './types';
import { normalizeEmail, normalizeName } from './parse';

export interface MatchableContact {
  id: string;
  fullName: string;
  email: string | null;
}

export interface MatchAttendeesOptions {
  /**
   * Minimum confidence linked without asking. Defaults to
   * `AUTO_MATCH_CONFIDENCE` (0.9) — exact email or exact name.
   */
  autoConfidence?: number;
}

export interface MatchAttendeesResult {
  matches: AttendeeMatch[];
  matched: number;
  review: number;
  ambiguous: number;
  unmatched: number;
}

interface Indexed {
  byEmail: Map<string, string[]>;
  byName: Map<string, string[]>;
  contacts: Map<string, MatchableContact>;
}

function tokenize(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean);
}

/**
 * `Ada L.` / `A Lovelace` ↔ `Ada Lovelace`: identical last token, and one
 * side's first token is the other's first initial.
 */
function initialsKey(tokens: string[]): string | null {
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1]!;
  const first = tokens[0]!;
  return `${last}|${first[0]}`;
}

function index(contacts: readonly MatchableContact[]): Indexed {
  const byEmail = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const map = new Map<string, MatchableContact>();

  for (const contact of contacts) {
    map.set(contact.id, contact);
    const email = normalizeEmail(contact.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), contact.id]);
    const name = normalizeName(contact.fullName);
    if (name) byName.set(name, [...(byName.get(name) ?? []), contact.id]);
  }
  return { byEmail, byName, contacts: map };
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const existing = map.get(key);
  if (!existing) map.set(key, [id]);
  else if (!existing.includes(id)) existing.push(id);
}

/** Second index: initials keys, built lazily (only when a name tier misses). */
function initialsIndex(contacts: readonly MatchableContact[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const contact of contacts) {
    const key = initialsKey(tokenize(contact.fullName));
    if (key) push(out, key, contact.id);
  }
  return out;
}

function candidateList(
  idx: Indexed,
  ids: string[],
  limit = EVENT_LIMITS.candidates
): Array<{ id: string; fullName: string; email: string | null }> {
  return ids
    .map((id) => idx.contacts.get(id))
    .filter((c): c is MatchableContact => Boolean(c))
    .map((c) => ({ id: c.id, fullName: c.fullName, email: c.email }))
    .slice(0, limit);
}

function describe(ref: AttendeeRef): string {
  return ref.email ?? ref.name ?? '(blank attendee)';
}

/**
 * Match every attendee line against the contact list. The result is ordered
 * like the input so a summary can be zipped against the original file.
 */
export function matchAttendees(
  attendees: readonly AttendeeRef[],
  contacts: readonly MatchableContact[],
  opts: MatchAttendeesOptions = {}
): MatchAttendeesResult {
  const auto = opts.autoConfidence ?? AUTO_MATCH_CONFIDENCE;
  const idx = index(contacts);
  let initials: Map<string, string[]> | null = null;
  const matches: AttendeeMatch[] = [];

  for (const ref of attendees) {
    const email = normalizeEmail(ref.email);
    const nameKey = normalizeName(ref.name);
    if (!email && !nameKey) {
      matches.push({
        ref,
        status: 'unmatched',
        contactId: null,
        confidence: 0,
        via: null,
        candidates: [],
        reason: 'no email or name in that line',
      });
      continue;
    }

    const hits: Array<{ id: string; confidence: number; via: MatchVia }> = [];

    if (email) {
      for (const id of idx.byEmail.get(email) ?? []) hits.push({ id, confidence: 1, via: 'email' });
    }
    if (nameKey) {
      for (const id of idx.byName.get(nameKey) ?? []) hits.push({ id, confidence: 0.9, via: 'name' });
    }

    let best = hits.reduce<(typeof hits)[number] | null>(
      (acc, hit) => (!acc || hit.confidence > acc.confidence ? hit : acc),
      null
    );
    let via: MatchVia | null = best?.via ?? null;

    // Tier 3 only runs when the trusted tiers found nothing.
    if (!best && ref.name) {
      const tokens = tokenize(ref.name);
      const key = initialsKey(tokens);
      if (key) {
        initials ??= initialsIndex(contacts);
        for (const id of initials.get(key) ?? []) hits.push({ id, confidence: 0.6, via: 'initials' });
        best = hits.reduce<(typeof hits)[number] | null>(
          (acc, hit) => (!acc || hit.confidence > acc.confidence ? hit : acc),
          null
        );
        via = best?.via ?? null;
      }
    }

    const distinct = [...new Set(hits.map((h) => h.id))];

    if (distinct.length > 1) {
      // Never pick between people: hand the candidates back.
      matches.push({
        ref,
        status: 'ambiguous',
        contactId: null,
        confidence: best?.confidence ?? 0,
        via,
        candidates: candidateList(idx, distinct),
        reason: `${distinct.length} contacts match "${describe(ref)}"`,
      });
      continue;
    }

    if (!best) {
      matches.push({
        ref,
        status: 'unmatched',
        contactId: null,
        confidence: 0,
        via: null,
        candidates: [],
        reason: `no contact matches "${describe(ref)}"`,
      });
      continue;
    }

    const status = best.confidence >= auto ? 'matched' : 'review';
    matches.push({
      ref,
      status,
      contactId: best.id,
      confidence: best.confidence,
      via,
      candidates: hits.length > 1 ? candidateList(idx, distinct) : [],
      reason:
        via === 'email'
          ? 'email matches exactly'
          : via === 'name'
            ? 'name matches exactly'
            : 'last name and first initial match — confirm before linking',
    });
  }

  const count = (status: AttendeeMatch['status']): number =>
    matches.filter((m) => m.status === status).length;

  return {
    matches,
    matched: count('matched'),
    review: count('review'),
    ambiguous: count('ambiguous'),
    unmatched: count('unmatched'),
  };
}

/** The matches a caller should act on: `matched`, plus `review` when asked. */
export function actionableMatches(
  result: MatchAttendeesResult,
  opts: { includeReview?: boolean } = {}
): AttendeeMatch[] {
  return result.matches.filter(
    (m) => m.status === 'matched' || (opts.includeReview === true && m.status === 'review')
  );
}
