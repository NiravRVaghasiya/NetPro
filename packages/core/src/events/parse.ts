// packages/core/src/events/parse.ts
//
// The event-CSV reader. Pure: text in, rows out, no database, no IO — so the
// same parser backs `netpro events import`, `POST /api/events` (CSV upload)
// and the tests.
//
// Real exports from Luma/Eventbrite/conference tools disagree about
// everything: `Event Name` vs `Name`, `Start Date` vs `starts_at`,
// `Attendees` vs `Attendee Emails`, `2026-09-14` vs `2026-09-14T09:00:00Z`.
// Rather than demanding one shape, headers resolve through an alias table
// with a documented regex fallback, and unparseable *dates* are rejected
// (silently shifting an event by a month is worse than not importing it).
// Ambiguous date formats (`03/04/2026` — March 4th or April 3rd?) are
// rejected too, on purpose.
import Papa from 'papaparse';
import { EVENT_LIMITS, EventError } from './types';
import type { AttendeeRef } from './types';

export interface ParsedEventRow {
  name: string;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  attendees: AttendeeRef[];
}

export interface ParseEventsCsvResult {
  rows: ParsedEventRow[];
  /** Fatal for the row: it is skipped and reported. */
  errors: Array<{ row: number; reason: string }>;
  /** Non-fatal: the row imported, but something in it was dropped. */
  warnings: Array<{ row: number; reason: string }>;
}

// ── Normalizers (shared with match.ts) ───────────────────────────────────

/** Lower-cased, trim; `null` when the text is not a plausible address. */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (v.startsWith('mailto:')) v = v.slice(7);
  // "Ada Lovelace <ada@engines.dev>" — take the angle-bracketed part.
  const angle = v.match(/<([^>]+)>/);
  if (angle) v = angle[1]!.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return null;
  return v;
}

/**
 * Lower-cased, de-accented, punctuation folded to spaces: `José A. Ruiz` and
 * `jose a ruiz` and `josé ruiz` all land on `jose a ruiz`.
 */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ── Dates ────────────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD` (or `/`), optional `HH:MM[:SS][.sss]`, optional `Z` / `±HH:MM`.
 * The full ISO form (`2026-09-14T09:30:00.000Z`) round-trips, which is what
 * lets an already-parsed row be handed back to `upsertEvent`.
 * Returns a UTC ISO timestamp, or `null` when the text is not that shape.
 * `2026-02-31` is rejected rather than rolled forward to March.
 */
export function parseEventDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s
    .replace(/\//g, '-')
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? '0');
  const minute = Number(m[5] ?? '0');
  const second = Number(m[6] ?? '0');
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(ms);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  const zone = m[7];
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(-2));
    if (!Number.isFinite(zh) || !Number.isFinite(zm) || zh > 23 || zm > 59) return null;
    ms -= sign * (zh * 60 + zm) * 60_000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ── Headers ──────────────────────────────────────────────────────────────

type Field = 'name' | 'location' | 'startsAt' | 'endsAt' | 'attendees' | 'names' | 'role';

const ALIASES: Record<Field, readonly string[]> = {
  name: ['name', 'event', 'event name', 'event title', 'title', 'conference'],
  location: ['location', 'city', 'venue', 'place', 'address', 'country'],
  startsAt: ['starts at', 'starts', 'start date', 'start time', 'start', 'date', 'begins', 'begins at'],
  endsAt: ['ends at', 'ends', 'end date', 'end time', 'end', 'finish', 'until'],
  attendees: ['attendees', 'attendee emails', 'attendee email', 'emails', 'email', 'guests', 'participants', 'people'],
  names: ['attendee names', 'attendee name', 'names', 'name list'],
  role: ['role', 'attendee role', 'ticket', 'ticket type', 'type'],
};

/** Ordered longest-first so `attendee names` is tested before `attendees`. */
const FALLBACKS: Record<Field, RegExp> = {
  name: /(^|\s)(name|event|title|conference)(\s|$)/,
  location: /(location|city|venue|place|address)/,
  startsAt: /(start|begin|from)/,
  endsAt: /(end|finish|until)/,
  attendees: /(attend|participant|guest|email|people)/,
  names: /(names?)$/,
  role: /(role|ticket|type)/,
};

const RESOLUTION_ORDER: Field[] = ['names', 'role', 'startsAt', 'endsAt', 'location', 'name', 'attendees'];

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveHeaders(headers: string[]): Partial<Record<Field, string>> {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const out: Partial<Record<Field, string>> = {};
  const taken = new Set<string>();

  for (const field of RESOLUTION_ORDER) {
    for (const alias of ALIASES[field]) {
      const hit = normalized.find((h) => !taken.has(h.raw) && h.key === alias);
      if (hit) {
        out[field] = hit.raw;
        taken.add(hit.raw);
        break;
      }
    }
  }
  for (const field of RESOLUTION_ORDER) {
    if (out[field]) continue;
    const hit = normalized.find((h) => !taken.has(h.raw) && FALLBACKS[field].test(h.key));
    if (hit) {
      out[field] = hit.raw;
      taken.add(hit.raw);
    }
  }
  return out;
}

// ── Attendee lists ───────────────────────────────────────────────────────

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

interface SplitResult {
  attendees: AttendeeRef[];
  /** Tokens that were neither a usable email nor a name. */
  skipped: number;
}

/**
 * Split one cell into attendee refs. Separators are `,` `;` `|` and newline,
 * so both `a@b.com; c@d.com` and a quoted `"a@b.com, c@d.com"` work. A token
 * containing `@` is an email; anything else is a name. `forceName` is set for
 * an explicit `names` column, where `a@b.com` would be a person's label.
 */
export function splitAttendees(
  value: string | null | undefined,
  opts: { forceName?: boolean; role?: string | null } = {}
): SplitResult {
  const raw = value?.trim();
  if (!raw) return { attendees: [], skipped: 0 };
  const attendees: AttendeeRef[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const token of raw.split(/[,;|\n\r]+/)) {
    const text = token.trim();
    if (!text) continue;
    const role = optionalText(opts.role, EVENT_LIMITS.role);

    if (!opts.forceName && text.includes('@')) {
      const email = normalizeEmail(text);
      if (!email) {
        skipped++;
        continue;
      }
      if (seen.has(`e:${email}`)) continue;
      seen.add(`e:${email}`);
      attendees.push({ email, name: null, role });
      continue;
    }

    const name = text.slice(0, EVENT_LIMITS.name);
    const key = `n:${normalizeName(name)}`;
    if (!key.slice(2)) {
      skipped++;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    attendees.push({ email: null, name, role });
    if (attendees.length >= EVENT_LIMITS.attendeesPerEvent) break;
  }

  return { attendees, skipped };
}

// ── The parser ───────────────────────────────────────────────────────────

/**
 * Parse an events CSV into rows ready to import.
 *
 * Throws only when the file is structurally unusable (no header, no name
 * column, no rows); per-row problems come back in `errors`/`warnings` so one
 * bad line never costs the whole file.
 */
export function parseEventsCsv(csv: string): ParseEventsCsvResult {
  const parsed = Papa.parse<Record<string, string | undefined>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = (parsed.meta.fields ?? []).filter((h): h is string => typeof h === 'string');
  if (headers.length === 0 || parsed.data.length === 0) {
    throw new EventError(
      'invalid_input',
      'CSV is empty or missing a header row (expected at least a "name" column).'
    );
  }

  const cols = resolveHeaders(headers);
  if (!cols.name) {
    throw new EventError(
      'invalid_input',
      `CSV has no event-name column. Expected one of: ${ALIASES.name.join(', ')}.`
    );
  }

  const rows: ParsedEventRow[] = [];
  const errors: ParseEventsCsvResult['errors'] = [];
  const warnings: ParseEventsCsvResult['warnings'] = [];

  for (const [index, row] of parsed.data.entries()) {
    const line = index + 2; // 1-based header + 0-based data index
    if (index >= EVENT_LIMITS.eventsPerImport) {
      warnings.push({
        row: line,
        reason: `skipped: only the first ${EVENT_LIMITS.eventsPerImport} rows of one file are imported.`,
      });
      continue;
    }

    const name = optionalText(row[cols.name], EVENT_LIMITS.name);
    if (!name) {
      errors.push({ row: line, reason: 'event name is required' });
      continue;
    }

    const startsRaw = cols.startsAt ? optionalText(row[cols.startsAt], 64) : null;
    const endsRaw = cols.endsAt ? optionalText(row[cols.endsAt], 64) : null;
    const startsAt = parseEventDate(startsRaw);
    const endsAt = parseEventDate(endsRaw);
    if (startsRaw && !startsAt) {
      errors.push({ row: line, reason: `"${startsRaw}" is not a date NetPro can read (use YYYY-MM-DD).` });
      continue;
    }
    if (endsRaw && !endsAt) {
      errors.push({ row: line, reason: `"${endsRaw}" is not a date NetPro can read (use YYYY-MM-DD).` });
      continue;
    }
    if (startsAt && endsAt && endsAt < startsAt) {
      errors.push({ row: line, reason: 'ends before it starts' });
      continue;
    }

    const role = cols.role ? optionalText(row[cols.role], EVENT_LIMITS.role) : null;
    const byEmail = splitAttendees(cols.attendees ? row[cols.attendees] : null, { role });
    const byName = splitAttendees(cols.names ? row[cols.names] : null, { role, forceName: true });
    const attendees = [...byEmail.attendees, ...byName.attendees].slice(
      0,
      EVENT_LIMITS.attendeesPerEvent
    );
    const skipped = byEmail.skipped + byName.skipped;
    if (skipped > 0) {
      warnings.push({
        row: line,
        reason: `${skipped} unreadable attendee ${skipped === 1 ? 'entry' : 'entries'} skipped.`,
      });
    }
    if (byEmail.attendees.length + byName.attendees.length > attendees.length) {
      warnings.push({
        row: line,
        reason: `only the first ${EVENT_LIMITS.attendeesPerEvent} attendees were imported.`,
      });
    }

    rows.push({
      name,
      location: cols.location ? optionalText(row[cols.location], EVENT_LIMITS.location) : null,
      startsAt,
      endsAt,
      attendees,
    });
  }

  return { rows, errors, warnings };
}
