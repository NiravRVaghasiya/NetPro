// packages/core/src/events/types.ts
//
// v2.0 Phase 6 — the event matcher's vocabulary, limits and errors.
//
// The schema (`events`, `event_attendees`) shipped in Phase 1's migration
// `0003`, so this phase is logic-only: no migrations, no new columns, no new
// runtime dependencies.
//
// Two rules carry through the whole module:
//
//   1. **An attendee row is a claim you made; an edge between two attendees
//      is a claim NetPro made.** Importing an attendee list says "these
//      people were at this event"; it does not say they met. So imported
//      `met_at_event` edges land `pending` — exactly like LinkedIn's
//      "Mutual connections" — and wait for confirmation on `/edges`.
//   2. **Every match explains itself.** Each attendee match carries the
//      tier it matched on (`email` / `name` / `initials`), a confidence, and
//      the candidates it hesitated between. Ambiguity is returned, never
//      resolved by guessing.
export const MODULE_NAME = 'events';

/** How the event row arrived. `provider` is reserved for the deferred discovery API. */
export const EVENT_SOURCES = ['manual', 'import', 'provider'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** How an attendance row was written — drives edge status (see rule 1 above). */
export const ATTENDANCE_VIAS = ['manual', 'import'] as const;
export type AttendanceVia = (typeof ATTENDANCE_VIAS)[number];

export const EVENT_LIMITS = {
  name: 200,
  location: 200,
  query: 200,
  /** Per-attendee free-text role ("speaker", "sponsor"). */
  role: 80,
  /** Attendees accepted for one event in a single import. */
  attendeesPerEvent: 5_000,
  /** Events accepted in a single import. */
  eventsPerImport: 1_000,
  /** Contacts scanned when matching — a single-owner tool reads the network once. */
  contacts: 10_000,
  /**
   * Met-at-event edges written per event, per run. Pairwise linking is O(n²)
   * (a 500-person event would be 124,750 edges), so the run stops at the cap
   * and says so in the summary rather than silently writing a fraction.
   */
  edgesPerEvent: 250,
  /** Candidates returned for an ambiguous attendee. */
  candidates: 5,
} as const;

/** Confidence at or above this is linked without asking. */
export const AUTO_MATCH_CONFIDENCE = 0.9;

export type EventErrorCode = 'invalid_input' | 'not_found' | 'conflict';

export class EventError extends Error {
  readonly code: EventErrorCode;
  constructor(code: EventErrorCode, message: string) {
    super(message);
    this.name = 'EventError';
    this.code = code;
  }
}

export interface EventOptions {
  now?: Date;
}

export function resolveNow(opts: EventOptions = {}): Date {
  return opts.now ?? new Date();
}

/** A row of the `events` table. */
export interface EventRecord {
  id: string;
  name: string;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  source: string;
  createdAt: string;
}

export interface EventSummary extends EventRecord {
  /** Contacts in your network linked to this event (soft-deleted excluded). */
  attendeeCount: number;
}

/** Who an attendee list says was there, before (or without) matching. */
export interface AttendeeRef {
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface AttendeeRecord {
  contactId: string;
  fullName: string;
  email: string | null;
  company: string | null;
  /** Their role at the event ("speaker"), not their job title. */
  eventRole: string | null;
  /** False for an event that has not started yet: attendance is planned. */
  attended: boolean;
  discoveredAt: string;
  relationshipScore: number | null;
}

/** An attendee row that no contact could be matched to, kept for manual linking. */
export interface UnmatchedAttendee {
  name: string | null;
  email: string | null;
  reason: string;
}

export interface EventDetail {
  event: EventRecord;
  attendees: AttendeeRecord[];
  attendeeCount: number;
  /** Distinct industries of the matched attendees, most common first. */
  industries: string[];
  /** Distinct companies of the matched attendees, most common first. */
  companies: string[];
  /** Attendees from the last import/match that matched nothing (or too much). */
  unmatched: UnmatchedAttendee[];
}

export type MatchStatus = 'matched' | 'review' | 'ambiguous' | 'unmatched';
export type MatchVia = 'email' | 'name' | 'initials';

export interface AttendeeMatch {
  ref: AttendeeRef;
  status: MatchStatus;
  contactId: string | null;
  /** 1 exact email · 0.9 exact name · 0.6 last name + first initial · 0 nothing. */
  confidence: number;
  via: MatchVia | null;
  /** Populated for `ambiguous` (and for `matched`/`review` when it was close). */
  candidates: Array<{ id: string; fullName: string; email: string | null }>;
  reason: string;
}

export interface EventRecommendation {
  event: EventSummary;
  /** 0–1, two decimals: peers 0.6 · industry fit 0.2 · timing 0.2. */
  score: number;
  /** Plain-language component breakdown — the number is never unexplained. */
  reasons: string[];
  attendees: Array<{
    contactId: string;
    fullName: string;
    company: string | null;
    relationshipScore: number | null;
  }>;
}

export interface EventsStatus {
  events: number;
  attendees: number;
  /** Rows linking a contact to an event (one contact can attend many events). */
  links: number;
  contacts: number;
  /** Events that have at least one attendee from your network. */
  withAttendees: number;
}
