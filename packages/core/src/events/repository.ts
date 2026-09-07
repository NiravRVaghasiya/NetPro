// packages/core/src/events/repository.ts
//
// v2.0 Phase 6 — the database half of the event matcher.
//
// Reads are raw ANSI SQL through the same `rawAll` helper the search indexer
// and the skills module use: one query text, both dialects, no per-dialect
// duplication. Writes go through Drizzle inside a dialect branch because the
// `SqliteConn | PgConn` union cannot be narrowed for a typed insert.
//
// Two invariants the rest of the phase depends on:
//
//   * **Idempotent imports.** Re-importing the same file adds no rows: events
//     dedupe on normalized name, attendance on (event, contact).
//   * **Imported contact↔contact edges are `pending`.** An attendee list is
//     evidence of attendance, not of a meeting, so `met_at_event` edges from
//     an import wait for confirmation on `/edges`. Manual links
//     (`netpro events link`, the web "Add attendee" form) are `confirmed` —
//     that is the owner speaking, not an export file.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getContactById } from '../ai/resolve-contact';
import { writeActivityLog } from '../crm/activity';
import { addEdge } from '../graph/edges';
import { rawAll } from '../search/indexer';
import { matchAttendees, type MatchableContact } from './match';
import {
  normalizeEmail,
  normalizeName,
  parseEventDate,
  parseEventsCsv,
  type ParsedEventRow,
} from './parse';
import {
  ATTENDANCE_VIAS,
  EVENT_LIMITS,
  EVENT_SOURCES,
  EventError,
  resolveNow,
  type AttendanceVia,
  type AttendeeRecord,
  type AttendeeRef,
  type EventDetail,
  type EventOptions,
  type EventRecommendation,
  type EventRecord,
  type EventSource,
  type AttendeeMatch,
  type EventSummary,
  type EventsStatus,
  type UnmatchedAttendee,
} from './types';

type Conn = SqliteConn | PgConn;

// ── Small shared validation ──────────────────────────────────────────────

function text(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new EventError('invalid_input', `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new EventError('invalid_input', `"${field}" must be ${max} characters or fewer.`);
  }
  return trimmed === '' ? null : trimmed;
}

function whitelist<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new EventError(
    'invalid_input',
    `Unknown ${field} "${String(value)}". Expected one of: ${allowed.join(', ')}.`
  );
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Escape LIKE wildcards so a search for `100%` is not "anything". */
function likePattern(query: string): string {
  const trimmed = query.trim().slice(0, EVENT_LIMITS.query).toLowerCase();
  return `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Row shapes ───────────────────────────────────────────────────────────

interface EventSqlRow extends Record<string, unknown> {
  id: string;
  name: string;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  source: string;
  created_at: string;
  attendee_count?: number | string;
}

function toEvent(r: EventSqlRow): EventRecord {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    source: r.source,
    createdAt: r.created_at,
  };
}

function toSummary(r: EventSqlRow): EventSummary {
  return { ...toEvent(r), attendeeCount: num(r.attendee_count ?? 0) };
}

const EVENT_SELECT = sql`SELECT e.id AS id, e.name AS name, e.location AS location,
  e.starts_at AS starts_at, e.ends_at AS ends_at, e.source AS source, e.created_at AS created_at`;

const COUNT_SUBQUERY = sql`, (SELECT COUNT(*) FROM event_attendees a
     JOIN contacts c ON c.id = a.contact_id
     WHERE a.event_id = e.id AND c.deleted_at IS NULL) AS attendee_count`;

// ── Reads ────────────────────────────────────────────────────────────────

/** Every live contact, in the shape the matcher needs (id, name, email). */
export async function loadMatchableContacts(conn: Conn): Promise<MatchableContact[]> {
  const rows = await rawAll<{ id: string; full_name: string; email: string | null }>(
    conn,
    sql`SELECT id, full_name, email FROM contacts
        WHERE deleted_at IS NULL
        ORDER BY id
        LIMIT ${EVENT_LIMITS.contacts}`
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email }));
}

export interface ListEventsOptions {
  query?: string;
  /** Only events that have not started yet. */
  upcoming?: boolean;
  limit?: number;
  offset?: number;
  now?: Date;
}

export interface ListEventsResult {
  events: EventSummary[];
  total: number;
  limit: number;
  offset: number;
}

function buildEventFilters(
  opts: ListEventsOptions
): { where: SQL; } {
  const parts: SQL[] = [];
  const q = opts.query?.trim();
  if (q) parts.push(sql`lower(e.name) LIKE ${likePattern(q)} ESCAPE '\\'`);
  if (opts.upcoming === true) {
    const nowIso = resolveNow(opts).toISOString();
    parts.push(sql`e.starts_at IS NOT NULL AND e.starts_at >= ${nowIso}`);
  }
  const where = parts.length === 0 ? sql`` : sql` WHERE ${sql.join(parts, sql` AND `)}`;
  return { where };
}

type SQL = ReturnType<typeof sql>;

/** Events with network-attendee counts, newest first (no date last). */
export async function listEvents(
  conn: Conn,
  opts: ListEventsOptions = {}
): Promise<ListEventsResult> {
  const limit = clampInt(opts.limit, 50, 1, 200);
  const offset = clampInt(opts.offset, 0, 0, 100_000);
  const { where } = buildEventFilters(opts);

  const rows = await rawAll<EventSqlRow>(
    conn,
    sql`${EVENT_SELECT}${COUNT_SUBQUERY} FROM events e${where}
        ORDER BY (e.starts_at IS NULL), e.starts_at DESC, e.name ASC
        LIMIT ${limit} OFFSET ${offset}`
  );
  const counted = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(*) AS n FROM events e${where}`
  );
  return {
    events: rows.map(toSummary),
    total: num(counted[0]?.n ?? 0),
    limit,
    offset,
  };
}

export async function countEvents(conn: Conn, opts: ListEventsOptions = {}): Promise<number> {
  const { where } = buildEventFilters(opts);
  const rows = await rawAll<{ n: number | string }>(conn, sql`SELECT COUNT(*) AS n FROM events e${where}`);
  return num(rows[0]?.n ?? 0);
}

async function eventRowById(conn: Conn, id: string): Promise<EventRecord | null> {
  const rows = await rawAll<EventSqlRow>(conn, sql`${EVENT_SELECT} FROM events e WHERE e.id = ${id}`);
  return rows[0] ? toEvent(rows[0]) : null;
}

async function eventRowsByName(conn: Conn, name: string): Promise<EventRecord[]> {
  const rows = await rawAll<EventSqlRow>(
    conn,
    sql`${EVENT_SELECT} FROM events e WHERE lower(e.name) = ${name.trim().toLowerCase()}`
  );
  return rows.map(toEvent);
}

/**
 * Resolve an id or an exact (case-insensitive) event name to one event.
 * Ambiguity is an error, never a coin flip — the message starts with
 * "Ambiguous" so the web layer can map it to 400 like the contact resolver.
 */
export async function resolveEventRef(conn: Conn, selector: string): Promise<EventRecord> {
  const trimmed = selector.trim();
  if (!trimmed) throw new EventError('invalid_input', 'An event id or name is required.');
  const byId = await eventRowById(conn, trimmed);
  if (byId) return byId;
  const byName = await eventRowsByName(conn, trimmed);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new EventError(
      'conflict',
      `Ambiguous event "${trimmed}" — ${byName.length} events share that name. Use the id (${byName
        .map((e) => e.id.slice(0, 8))
        .join(', ')}).`
    );
  }
  throw new EventError('not_found', `No event found with id or name "${trimmed}".`);
}

interface AttendeeSqlRow extends Record<string, unknown> {
  contact_id: string;
  full_name: string;
  email: string | null;
  company: string | null;
  industry: string | null;
  role: string | null;
  attended: boolean | number | string;
  discovered_at: string;
  relationship_score: number | string | null;
}

function toAttendee(r: AttendeeSqlRow): AttendeeRecord & { industry: string | null } {
  const score = r.relationship_score === null ? null : num(r.relationship_score);
  return {
    contactId: r.contact_id,
    fullName: r.full_name,
    email: r.email,
    company: r.company,
    eventRole: r.role,
    attended: bool(r.attended),
    discoveredAt: r.discovered_at,
    relationshipScore: score === null ? null : score,
    industry: r.industry,
  };
}

async function attendeeRows(conn: Conn, eventId: string): Promise<Array<AttendeeRecord & { industry: string | null }>> {
  const rows = await rawAll<AttendeeSqlRow>(
    conn,
    sql`SELECT a.contact_id AS contact_id, c.full_name AS full_name, c.email AS email,
               c.company AS company, c.industry AS industry, a.role AS role,
               a.attended AS attended, a.discovered_at AS discovered_at,
               c.relationship_score AS relationship_score
        FROM event_attendees a
        JOIN contacts c ON c.id = a.contact_id
        WHERE a.event_id = ${eventId} AND c.deleted_at IS NULL
        ORDER BY (c.relationship_score IS NULL), c.relationship_score DESC, c.full_name ASC`
  );
  return rows.map(toAttendee);
}

function tally(values: Array<string | null>, limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const v = value?.trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * One event: who in your network was there, what they do, and the attendee
 * lines from the last import that matched nothing (kept so the owner can
 * link them by hand rather than losing them).
 */
export async function getEvent(conn: Conn, eventId: string): Promise<EventDetail | null> {
  const event = await eventRowById(conn, eventId.trim());
  if (!event) return null;
  const rows = await attendeeRows(conn, event.id);
  const bucket = await loadUnmatchedBucket(conn, event.id);
  return {
    event,
    attendees: rows.map(({ industry: _industry, ...rest }) => rest),
    attendeeCount: rows.length,
    industries: tally(rows.map((r) => r.industry)),
    companies: tally(rows.map((r) => r.company)),
    unmatched: bucket.unmatched,
  };
}

/** Events one contact went to (newest first) — used by the contact page. */
export async function listContactEvents(conn: Conn, contactId: string): Promise<EventSummary[]> {
  const rows = await rawAll<EventSqlRow>(
    conn,
    sql`${EVENT_SELECT}${COUNT_SUBQUERY}
        FROM events e
        JOIN event_attendees a ON a.event_id = e.id
        WHERE a.contact_id = ${contactId.trim()}
        ORDER BY (e.starts_at IS NULL), e.starts_at DESC, e.name ASC`
  );
  return rows.map(toSummary);
}

// ── The unmatched bucket ─────────────────────────────────────────────────
//
// Phase 6 ships no migration, so the attendee lines an import could not match
// are parked in `activity_log` (one row per event, replaced on each run)
// instead of in a new table. `getEvent` reads the newest one back.

const BUCKET_ACTION = 'events.unmatched';

interface Bucket extends Record<string, unknown> {
  unmatched: unknown;
  ambiguous: unknown;
  at: unknown;
  metadata: unknown;
}

async function saveUnmatchedBucket(
  conn: Conn,
  eventId: string,
  unmatched: UnmatchedAttendee[],
  ambiguous: AttendeeRef[]
): Promise<void> {
  await writeActivityLog(conn, {
    action: BUCKET_ACTION,
    entityType: 'event',
    entityId: eventId,
    metadata: { unmatched, ambiguous, at: new Date().toISOString() },
  });
}

async function loadUnmatchedBucket(
  conn: Conn,
  eventId: string
): Promise<{ unmatched: UnmatchedAttendee[]; ambiguous: AttendeeRef[] }> {
  const rows = await rawAll<Bucket>(
    conn,
    sql`SELECT metadata FROM activity_log
        WHERE action = ${BUCKET_ACTION} AND entity_type = 'event' AND entity_id = ${eventId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
  );
  const meta = parseJson(rows[0]?.metadata);
  if (!meta) return { unmatched: [], ambiguous: [] };
  const unmatched = Array.isArray(meta.unmatched) ? (meta.unmatched as UnmatchedAttendee[]) : [];
  const ambiguous = Array.isArray(meta.ambiguous) ? (meta.ambiguous as AttendeeRef[]) : [];
  return { unmatched, ambiguous };
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface UpsertEventInput {
  name: string;
  location?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  source?: EventSource | string;
}

export interface UpsertEventResult {
  event: EventRecord;
  created: boolean;
}

/** Create an event, or return the existing one with the same (normalized) name. */
export async function upsertEvent(
  conn: Conn,
  input: UpsertEventInput,
  opts: EventOptions = {}
): Promise<UpsertEventResult> {
  const name = text(input.name, EVENT_LIMITS.name, 'name');
  if (!name) throw new EventError('invalid_input', 'Event name is required.');
  const source = whitelist(input.source, EVENT_SOURCES, 'source', 'manual');

  const startsRaw = text(input.startsAt, 64, 'startsAt');
  const endsRaw = text(input.endsAt, 64, 'endsAt');
  const startsAt = startsRaw === null ? null : parseEventDate(startsRaw);
  const endsAt = endsRaw === null ? null : parseEventDate(endsRaw);
  if (startsRaw !== null && startsAt === null) {
    throw new EventError('invalid_input', `"${startsRaw}" is not a date NetPro can read (use YYYY-MM-DD).`);
  }
  if (endsRaw !== null && endsAt === null) {
    throw new EventError('invalid_input', `"${endsRaw}" is not a date NetPro can read (use YYYY-MM-DD).`);
  }
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new EventError('invalid_input', 'An event cannot end before it starts.');
  }

  const existing = await eventRowsByName(conn, name);
  if (existing.length > 0) return { event: existing[0]!, created: false };

  const row: EventRecord = {
    id: randomUUID(),
    name,
    location: text(input.location, EVENT_LIMITS.location, 'location'),
    startsAt,
    endsAt,
    source,
    createdAt: resolveNow(opts).toISOString(),
  };
  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.events).values(row);
  } else {
    await conn.db.insert(conn.schema.events).values(row);
  }
  await writeActivityLog(conn, {
    action: 'event.created',
    entityType: 'event',
    entityId: row.id,
    metadata: { name: row.name, source },
  });
  return { event: row, created: true };
}

export interface LinkAttendeeInput {
  eventId: string;
  contactId: string;
  role?: string | null;
  /** Force `attended`; defaults to false for an event that has not started. */
  attended?: boolean;
  /** `manual` → confirmed edges; `import` → pending edges (see file header). */
  via?: AttendanceVia | string;
  /** Confidence of the attendance claim; carried onto the edges it creates. */
  confidence?: number;
  /** Skip the pairwise `met_at_event` edges entirely. */
  edges?: boolean;
  /** Spend from a caller-owned cap instead of starting a fresh one. */
  budget?: EdgeBudgetState;
}

export interface LinkAttendeeResult {
  eventId: string;
  contactId: string;
  created: boolean;
  edgesCreated: number;
  edgeCapReached: boolean;
}

async function isLinked(conn: Conn, eventId: string, contactId: string): Promise<boolean> {
  if (conn.dialect === 'sqlite') {
    const rows = await conn.db
      .select({ contactId: conn.schema.eventAttendees.contactId })
      .from(conn.schema.eventAttendees)
      .where(
        and(
          eq(conn.schema.eventAttendees.eventId, eventId),
          eq(conn.schema.eventAttendees.contactId, contactId)
        )
      )
      .limit(1);
    return rows.length > 0;
  }
  const rows = await conn.db
    .select({ contactId: conn.schema.eventAttendees.contactId })
    .from(conn.schema.eventAttendees)
    .where(
      and(
        eq(conn.schema.eventAttendees.eventId, eventId),
        eq(conn.schema.eventAttendees.contactId, contactId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function attendeeIds(conn: Conn, eventId: string): Promise<string[]> {
  const rows = await rawAll<{ contact_id: string }>(
    conn,
    sql`SELECT a.contact_id AS contact_id FROM event_attendees a
        JOIN contacts c ON c.id = a.contact_id
        WHERE a.event_id = ${eventId} AND c.deleted_at IS NULL`
  );
  return rows.map((r) => r.contact_id);
}

/**
 * A spendable cap on pairwise edges. One is created per event per run and
 * threaded through every `linkAttendee` call in that run, so a large file
 * cannot mint thousands of edges by paying the cap once per attendee.
 */
export interface EdgeBudgetState {
  remaining: number;
  created: number;
  capped: boolean;
}

export function createEdgeBudget(limit: number = EVENT_LIMITS.edgesPerEvent): EdgeBudgetState {
  return { remaining: Math.max(0, Math.floor(limit)), created: 0, capped: false };
}

/**
 * Pairwise `met_at_event` edges from one new attendee to everyone already on
 * the event. Bounded: a 500-person conference would otherwise mean 124,750
 * edges, so the run stops at `EVENT_LIMITS.edgesPerEvent` and says so.
 */
async function linkEventEdges(
  conn: Conn,
  eventId: string,
  contactId: string,
  eventName: string,
  via: AttendanceVia,
  confidence: number,
  budget: EdgeBudgetState,
  opts: EventOptions
): Promise<void> {
  const others = (await attendeeIds(conn, eventId)).filter((id) => id !== contactId);
  for (const otherId of others) {
    if (budget.remaining <= 0) {
      budget.capped = true;
      return;
    }
    try {
      const result = await addEdge(
        conn,
        {
          sourceId: contactId,
          targetId: otherId,
          relation: 'met_at_event',
          source: 'event_import',
          status: via === 'manual' ? 'confirmed' : 'pending',
          confidence,
          context: eventName.slice(0, 500),
        },
        { ...opts, merge: true }
      );
      if (result.created) {
        budget.remaining--;
        budget.created++;
      }
    } catch {
      // A soft-deleted or vanished peer is not this write's problem.
    }
  }
}

/** Record that a contact attended an event (and link them to the other attendees). */
export async function linkAttendee(
  conn: Conn,
  input: LinkAttendeeInput,
  opts: EventOptions = {}
): Promise<LinkAttendeeResult> {
  const eventId = input.eventId?.trim();
  const contactId = input.contactId?.trim();
  if (!eventId || !contactId) {
    throw new EventError('invalid_input', 'Both eventId and contactId are required.');
  }
  const event = await eventRowById(conn, eventId);
  if (!event) throw new EventError('not_found', `No event with id "${eventId}".`);
  const contact = await getContactById(conn, contactId);
  if (!contact) {
    throw new EventError(
      'not_found',
      `No contact with id "${contactId}". Soft-deleted contacts cannot be linked to an event.`
    );
  }

  const via = whitelist(input.via, ATTENDANCE_VIAS, 'via', 'manual');
  const now = resolveNow(opts);
  const already = await isLinked(conn, event.id, contact.id);
  const budget = input.budget ?? createEdgeBudget();

  if (!already) {
    const role = text(input.role, EVENT_LIMITS.role, 'role');
    const attended = input.attended ?? !(event.startsAt && event.startsAt > now.toISOString());
    const row = {
      eventId: event.id,
      contactId: contact.id,
      role,
      attended,
      discoveredAt: now.toISOString(),
    };
    if (conn.dialect === 'sqlite') {
      await conn.db.insert(conn.schema.eventAttendees).values(row);
    } else {
      await conn.db.insert(conn.schema.eventAttendees).values(row);
    }
    await writeActivityLog(conn, {
      action: 'event.attendee_linked',
      entityType: 'event',
      entityId: event.id,
      metadata: { contactId: contact.id, via, role },
    });
  }

  let edgesCreated = 0;
  if (input.edges !== false) {
    const confidence =
      via === 'manual' ? 1 : Math.min(1, Math.max(0, input.confidence ?? 0.9));
    const before = budget.created;
    await linkEventEdges(conn, event.id, contact.id, event.name, via, confidence, budget, opts);
    // Report *this* call's edges, not the running total an import accumulates.
    edgesCreated = budget.created - before;
  }

  return {
    eventId: event.id,
    contactId: contact.id,
    created: !already,
    edgesCreated,
    edgeCapReached: budget.capped,
  };
}

/** Remove one attendance row. The edges it produced are facts you confirm elsewhere. */
export async function unlinkAttendee(
  conn: Conn,
  input: { eventId: string; contactId: string }
): Promise<{ eventId: string; contactId: string; removed: boolean }> {
  const eventId = input.eventId?.trim();
  const contactId = input.contactId?.trim();
  if (!eventId || !contactId) {
    throw new EventError('invalid_input', 'Both eventId and contactId are required.');
  }
  const removed = await isLinked(conn, eventId, contactId);
  if (conn.dialect === 'sqlite') {
    await conn.db
      .delete(conn.schema.eventAttendees)
      .where(
        and(
          eq(conn.schema.eventAttendees.eventId, eventId),
          eq(conn.schema.eventAttendees.contactId, contactId)
        )
      );
  } else {
    await conn.db
      .delete(conn.schema.eventAttendees)
      .where(
        and(
          eq(conn.schema.eventAttendees.eventId, eventId),
          eq(conn.schema.eventAttendees.contactId, contactId)
        )
      );
  }
  if (removed) {
    await writeActivityLog(conn, {
      action: 'event.attendee_unlinked',
      entityType: 'event',
      entityId: eventId,
      metadata: { contactId },
    });
  }
  return { eventId, contactId, removed };
}

/** Delete an event and its attendance rows (FK cascade). */
export async function removeEvent(conn: Conn, eventId: string): Promise<EventRecord> {
  const id = eventId.trim();
  const event = await eventRowById(conn, id);
  if (!event) throw new EventError('not_found', `No event with id "${id}".`);
  if (conn.dialect === 'sqlite') {
    await conn.db.delete(conn.schema.events).where(eq(conn.schema.events.id, id));
  } else {
    await conn.db.delete(conn.schema.events).where(eq(conn.schema.events.id, id));
  }
  await writeActivityLog(conn, { action: 'event.removed', entityType: 'event', entityId: id });
  return event;
}

// ── Import ───────────────────────────────────────────────────────────────

export interface ImportEventsOptions extends EventOptions {
  /** Raw CSV; parsed with `parseEventsCsv`. */
  csv?: string;
  /** Pre-parsed rows (the web route parses once and validates before writing). */
  rows?: ParsedEventRow[];
  /** Report only — no writes. */
  dryRun?: boolean;
  /** Write `met_at_event` edges between co-attendees (default true). */
  edges?: boolean;
  /** Also link `review`-tier matches (last name + first initial). Default false. */
  includeReview?: boolean;
  source?: EventSource | string;
}

export interface ImportEventsSummary {
  events: number;
  created: number;
  existing: number;
  /** Attendance rows written. */
  attendees: number;
  /** Attendance rows already present. */
  duplicates: number;
  matched: number;
  review: number;
  ambiguous: number;
  unmatched: number;
  edges: number;
  edgeCapReached: boolean;
  errors: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; reason: string }>;
  /** The attendee lines no contact could be matched to, for manual linking. */
  unmatchedRefs: UnmatchedAttendee[];
  ambiguousRefs: Array<{
    event: string;
    ref: AttendeeRef;
    candidates: Array<{ id: string; fullName: string; email: string | null }>;
  }>;
  dryRun: boolean;
}

function emptySummary(dryRun: boolean): ImportEventsSummary {
  return {
    events: 0,
    created: 0,
    existing: 0,
    attendees: 0,
    duplicates: 0,
    matched: 0,
    review: 0,
    ambiguous: 0,
    unmatched: 0,
    edges: 0,
    edgeCapReached: false,
    errors: [],
    warnings: [],
    unmatchedRefs: [],
    ambiguousRefs: [],
    dryRun,
  };
}

function toUnmatched(match: AttendeeMatch): UnmatchedAttendee {
  return {
    name: match.ref.name ?? null,
    email: match.ref.email ?? null,
    reason: match.reason,
  };
}

/**
 * Import events (and their attendee lists) from a CSV, matching attendees
 * against the network as it goes. Idempotent: re-importing the same file
 * writes nothing and reports every row as a duplicate.
 */
export async function importEvents(
  conn: Conn,
  opts: ImportEventsOptions = {}
): Promise<ImportEventsSummary> {
  const dryRun = opts.dryRun === true;
  const summary = emptySummary(dryRun);
  const parsed =
    opts.rows !== undefined
      ? { rows: opts.rows, errors: [], warnings: [] as Array<{ row: number; reason: string }> }
      : parseEventsCsv(opts.csv ?? '');
  summary.errors = parsed.errors;
  summary.warnings = parsed.warnings;
  if (parsed.rows.length === 0) return summary;

  const contacts = await loadMatchableContacts(conn);
  const now = resolveNow(opts);
  let capReached = false;

  for (const row of parsed.rows) {
    // One edge cap per event: a 500-person file spends it once, not 500 times.
    const budget = createEdgeBudget();
    let event: EventRecord;
    if (dryRun) {
      const found = await eventRowsByName(conn, row.name);
      event =
        found[0] ??
        ({
          id: 'dry-run',
          name: row.name,
          location: row.location,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          source: 'import',
          createdAt: now.toISOString(),
        } satisfies EventRecord);
      summary.events++;
      summary.existing += found.length > 0 ? 1 : 0;
      summary.created += found.length > 0 ? 0 : 1;
    } else {
      const upserted = await upsertEvent(
        conn,
        {
          name: row.name,
          location: row.location,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          source: opts.source ?? 'import',
        },
        { now }
      );
      event = upserted.event;
      summary.events++;
      if (upserted.created) summary.created++;
      else summary.existing++;
    }

    if (row.attendees.length === 0) continue;
    const result = matchAttendees(row.attendees, contacts);
    summary.matched += result.matched;
    summary.review += result.review;
    summary.ambiguous += result.ambiguous;
    summary.unmatched += result.unmatched;

    const unmatchedRefs: UnmatchedAttendee[] = [];
    for (const match of result.matches) {
      if (match.status === 'ambiguous') {
        unmatchedRefs.push(toUnmatched(match));
        summary.ambiguousRefs.push({
          event: row.name,
          ref: match.ref,
          candidates: match.candidates,
        });
        continue;
      }
      if (match.status === 'unmatched') {
        unmatchedRefs.push(toUnmatched(match));
        continue;
      }
      if (match.status === 'review' && opts.includeReview !== true) {
        unmatchedRefs.push(toUnmatched(match));
        continue;
      }
      if (!match.contactId) continue;

      if (dryRun) {
        summary.attendees++;
        continue;
      }
      const link = await linkAttendee(
        conn,
        {
          eventId: event.id,
          contactId: match.contactId,
          role: match.ref.role ?? null,
          via: 'import',
          confidence: match.confidence,
          edges: opts.edges !== false,
          budget,
        },
        { now }
      );
      if (link.created) summary.attendees++;
      else summary.duplicates++;
      summary.edges += link.edgesCreated;
      if (link.edgeCapReached) capReached = true;
    }

    summary.unmatchedRefs.push(...unmatchedRefs);
    if (!dryRun && event.id !== 'dry-run') {
      const ambiguousRefs = result.matches
        .filter((m) => m.status === 'ambiguous')
        .map((m) => m.ref);
      await saveUnmatchedBucket(conn, event.id, unmatchedRefs, ambiguousRefs);
    }
  }

  summary.edgeCapReached = capReached;
  if (!dryRun) {
    await writeActivityLog(conn, {
      action: 'events.imported',
      entityType: 'event',
      entityId: null,
      metadata: {
        events: summary.events,
        attendees: summary.attendees,
        matched: summary.matched,
        ambiguous: summary.ambiguous,
        unmatched: summary.unmatchedRefs.length,
      },
    });
  }
  return summary;
}

// ── Match an already-imported event ──────────────────────────────────────

export interface MatchEventOptions extends EventOptions {
  /** Write the `matched` rows. Default false — a preview first. */
  apply?: boolean;
  includeReview?: boolean;
  edges?: boolean;
}

export interface MatchEventResult {
  event: EventRecord;
  matched: number;
  review: number;
  ambiguous: number;
  unmatched: number;
  /** Attendance rows written (only when `apply`). */
  linked: number;
  duplicates: number;
  edges: number;
  edgeCapReached: boolean;
  matches: AttendeeMatch[];
  /** Attendee refs still unresolved after this run. */
  remaining: UnmatchedAttendee[];
  applied: boolean;
}

/**
 * Re-run matching for one event against the *current* network, using the
 * attendee lines the last import could not resolve. This is how a contact you
 * imported *after* the event file gets linked without re-importing anything.
 */
export async function matchEventAttendees(
  conn: Conn,
  eventId: string,
  opts: MatchEventOptions = {}
): Promise<MatchEventResult> {
  const event = await resolveEventRef(conn, eventId);
  const bucket = await loadUnmatchedBucket(conn, event.id);
  const refs: AttendeeRef[] = [...bucket.unmatched, ...bucket.ambiguous].map((ref) => ({
    name: ref?.name ?? null,
    email: ref?.email ?? null,
  }));
  const contacts = await loadMatchableContacts(conn);
  const result = matchAttendees(refs, contacts, {
    ...(opts.includeReview === true ? { autoConfidence: 0.6 } : {}),
  });
  const now = resolveNow(opts);
  const apply = opts.apply === true;
  const budget = createEdgeBudget();

  let linked = 0;
  let duplicates = 0;
  let edges = 0;
  const remaining: UnmatchedAttendee[] = [];

  for (const match of result.matches) {
    if (match.status !== 'matched' || !match.contactId) {
      remaining.push(toUnmatched(match));
      continue;
    }
    if (!apply) continue;

    const link = await linkAttendee(
      conn,
      {
        eventId: event.id,
        contactId: match.contactId,
        via: 'import',
        confidence: match.confidence,
        edges: opts.edges !== false,
        budget,
      },
      { now }
    );
    if (link.created) linked++;
    else duplicates++;
    edges += link.edgesCreated;
  }

  if (apply) {
    await saveUnmatchedBucket(
      conn,
      event.id,
      remaining,
      result.matches.filter((m) => m.status === 'ambiguous').map((m) => m.ref)
    );
    await writeActivityLog(conn, {
      action: 'events.matched',
      entityType: 'event',
      entityId: event.id,
      metadata: { linked, duplicates, edges, remaining: remaining.length },
    });
  }

  return {
    event,
    matched: result.matched,
    review: result.review,
    ambiguous: result.ambiguous,
    unmatched: result.unmatched,
    linked,
    duplicates,
    edges,
    edgeCapReached: budget.capped,
    matches: result.matches,
    remaining,
    applied: apply,
  };
}

// ── Recommendations ──────────────────────────────────────────────────────

export interface RecommendOptions extends EventOptions {
  limit?: number;
}

interface IndustryRow extends Record<string, unknown> {
  industry: string;
  n: number | string;
}

interface AttendeeLite extends Record<string, unknown> {
  event_id: string;
  contact_id: string;
  full_name: string;
  company: string | null;
  industry: string | null;
  relationship_score: number | string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function timingScore(startsAt: string | null, now: Date): { score: number; reason: string } {
  if (!startsAt) return { score: 0.3, reason: 'no date on file' };
  const start = new Date(startsAt).getTime();
  if (!Number.isFinite(start)) return { score: 0.3, reason: 'no date on file' };
  // Whole UTC days, the same granularity the CLI and the web use to print a
  // date, so "in 7d" and "starts in 7 days" can never disagree.
  const days = Math.round((utcDayStart(new Date(startsAt)) - utcDayStart(now)) / DAY_MS);
  if (days >= 0) {
    if (days === 0) return { score: 1, reason: 'starts today' };
    if (days === 1) return { score: 1, reason: 'starts tomorrow' };
    return { score: days <= 90 ? 1 : 0.8, reason: `starts in ${days} days` };
  }
  const ago = Math.abs(days);
  if (ago <= 365) return { score: 0.5, reason: `started ${ago} days ago` };
  return { score: 0.15, reason: `started ${Math.round(ago / 365)} years ago` };
}

/**
 * Which events matter to you? Ranked, and every number explained:
 *
 *   score = 0.6 × peers      (how many of your contacts went — 5 saturates it)
 *         + 0.2 × industry   (share of your network in the attendees' industries)
 *         + 0.2 × timing     (upcoming beats recent beats ancient)
 *
 * Only events with someone you know, or that have not happened yet, are
 * recommended; an empty past event is not a suggestion.
 */
export async function recommendEvents(
  conn: Conn,
  opts: RecommendOptions = {}
): Promise<EventRecommendation[]> {
  const limit = clampInt(opts.limit, 10, 1, 50);
  const now = resolveNow(opts);
  const nowIso = now.toISOString();

  const [events, attendeeRows, industryRows] = await Promise.all([
    rawAll<EventSqlRow>(
      conn,
      sql`${EVENT_SELECT}${COUNT_SUBQUERY} FROM events e
          ORDER BY (e.starts_at IS NULL), e.starts_at DESC, e.name ASC
          LIMIT ${EVENT_LIMITS.eventsPerImport}`
    ),
    rawAll<AttendeeLite>(
      conn,
      sql`SELECT a.event_id AS event_id, c.id AS contact_id, c.full_name AS full_name,
                 c.company AS company, c.industry AS industry,
                 c.relationship_score AS relationship_score
          FROM event_attendees a
          JOIN contacts c ON c.id = a.contact_id
          WHERE c.deleted_at IS NULL
          ORDER BY (c.relationship_score IS NULL), c.relationship_score DESC, c.full_name ASC`
    ),
    rawAll<IndustryRow>(
      conn,
      sql`SELECT industry, COUNT(*) AS n FROM contacts
          WHERE deleted_at IS NULL AND industry IS NOT NULL AND industry <> ''
          GROUP BY industry`
    ),
  ]);

  const networkByIndustry = new Map<string, number>();
  let industryTotal = 0;
  for (const row of industryRows) {
    const n = num(row.n);
    networkByIndustry.set(row.industry, n);
    industryTotal += n;
  }

  const byEvent = new Map<string, AttendeeLite[]>();
  for (const row of attendeeRows) {
    const list = byEvent.get(row.event_id);
    if (list) list.push(row);
    else byEvent.set(row.event_id, [row]);
  }

  const scored: EventRecommendation[] = [];
  for (const row of events) {
    const event = toSummary(row);
    const rows = byEvent.get(event.id) ?? [];
    const attendeeCount = num(row.attendee_count ?? rows.length);
    const upcoming = event.startsAt !== null && event.startsAt >= nowIso;
    if (attendeeCount === 0 && !upcoming) continue;

    const industries = [...new Set(rows.map((r) => r.industry).filter((i): i is string => Boolean(i)))];
    const industryShare =
      industryTotal === 0 || industries.length === 0
        ? 0
        : industries.reduce((sum, i) => sum + (networkByIndustry.get(i) ?? 0), 0) / industryTotal;

    const peers = Math.min(1, attendeeCount / 5);
    const timing = timingScore(event.startsAt, now);
    const score = Math.round((0.6 * peers + 0.2 * Math.min(1, industryShare) + 0.2 * timing.score) * 100) / 100;

    const reasons: string[] = [
      attendeeCount === 0
        ? 'nobody from your network yet'
        : `${attendeeCount} ${attendeeCount === 1 ? 'person' : 'people'} in your network`,
    ];
    if (industries.length > 0 && industryShare > 0) {
      reasons.push(
        `industries (${industries.slice(0, 3).join(', ')}) cover ${Math.round(industryShare * 100)}% of your network`
      );
    }
    reasons.push(timing.reason);

    scored.push({
      event,
      score,
      reasons,
      attendees: rows.slice(0, 5).map((r) => ({
        contactId: r.contact_id,
        fullName: r.full_name,
        company: r.company,
        relationshipScore:
          r.relationship_score === null ? null : num(r.relationship_score),
      })),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.event.attendeeCount - a.event.attendeeCount ||
      a.event.name.localeCompare(b.event.name)
  );
  return scored.slice(0, limit);
}

// ── Status ───────────────────────────────────────────────────────────────

export async function eventsStatus(conn: Conn): Promise<EventsStatus> {
  const [events, links, contacts, withAttendees] = await Promise.all([
    countEvents(conn),
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM event_attendees a
          JOIN contacts c ON c.id = a.contact_id
          WHERE c.deleted_at IS NULL`
    ),
    rawAll<{ n: number | string }>(conn, sql`SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL`),
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(DISTINCT event_id) AS n FROM event_attendees a
          JOIN contacts c ON c.id = a.contact_id
          WHERE c.deleted_at IS NULL`
    ),
  ]);
  const attendees = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(DISTINCT contact_id) AS n FROM event_attendees a
        JOIN contacts c ON c.id = a.contact_id
        WHERE c.deleted_at IS NULL`
  );
  return {
    events,
    attendees: num(attendees[0]?.n ?? 0),
    links: num(links[0]?.n ?? 0),
    contacts: num(contacts[0]?.n ?? 0),
    withAttendees: num(withAttendees[0]?.n ?? 0),
  };
}

/** Exposed for tests and for the CLI's "is this really the event I meant" check. */
export const __testing = {
  normalizeEmail,
  normalizeName,
  eventRowsByName,
};
