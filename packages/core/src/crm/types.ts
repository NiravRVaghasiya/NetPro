// packages/core/src/crm/types.ts
//
// Shared vocabulary, limits, errors, and time helpers for the CRM module.
//
// The interaction type / direction / channel vocabularies come from the
// "DB & Pipeline Deep Dive" schema comments and are whitelisted (not
// free-text) because relationship scoring counts *distinct types* and
// analytics group by these values — silent vocabulary drift would corrupt
// both. All timestamps are UTC ISO strings, matching the text columns in
// both dialects.

export const MODULE_NAME = 'crm';

/** Whitelisted interaction types (Deep Dive §interactions). */
export const INTERACTION_TYPES = [
  'email_sent',
  'email_received',
  'meeting',
  'call',
  'note',
  'linkedin_message',
  'intro_made',
  'follow_up_due',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const INTERACTION_DIRECTIONS = ['inbound', 'outbound'] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const INTERACTION_CHANNELS = [
  'email',
  'linkedin',
  'twitter',
  'in_person',
  'phone',
  'other',
] as const;
export type InteractionChannel = (typeof INTERACTION_CHANNELS)[number];

/** Follow-up lifecycle. Snoozing is a timestamp, not a status. */
export const FOLLOWUP_STATUSES = ['pending', 'completed', 'cancelled'] as const;
export type FollowUpStatus = (typeof FOLLOWUP_STATUSES)[number];

/** Field length caps — same validation discipline as the AI compose input. */
export const CRM_LIMITS = {
  subject: 200,
  content: 5000,
  reason: 500,
} as const;

/** Sensible direction when the caller doesn't specify one. */
export const DEFAULT_DIRECTIONS: Partial<Record<InteractionType, InteractionDirection>> = {
  email_sent: 'outbound',
  email_received: 'inbound',
  linkedin_message: 'outbound',
  intro_made: 'outbound',
};

export type CrmErrorCode = 'invalid_input' | 'not_found' | 'conflict';

/**
 * The CRM module's single error type. Web routes map `code` to HTTP status
 * (invalid_input → 400, not_found → 404, conflict → 409); the CLI prints the
 * message and exits non-zero.
 */
export class CrmError extends Error {
  readonly code: CrmErrorCode;
  constructor(code: CrmErrorCode, message: string) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
  }
}

/** Options accepted by CRM mutations. `now` is injectable for deterministic tests. */
export interface CrmOptions {
  now?: Date;
}

export function resolveNow(opts: CrmOptions = {}): Date {
  return opts.now ?? new Date();
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Recurrence/durations cap at 5 years — beyond that it's not a follow-up. */
export const MAX_DURATION_MS = 5 * 365 * DAY_MS;

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(h|d|w)$/i;

/**
 * Parse a human duration (`24h`, `7d`, `2w`) into milliseconds. Deliberately
 * no `m` unit: "m" is ambiguous between minutes and months, and minute-scale
 * follow-ups are not a real use case.
 */
export function parseDurationMs(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new CrmError(
      'invalid_input',
      `Invalid duration "${input}". Expected a number plus unit — h (hours), d (days), or w (weeks), e.g. "24h", "7d", "2w".`
    );
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const ms = Math.round(value * (unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : WEEK_MS));
  if (!(ms > 0)) {
    throw new CrmError('invalid_input', `Duration "${input}" must be greater than zero.`);
  }
  if (ms > MAX_DURATION_MS) {
    throw new CrmError('invalid_input', `Duration "${input}" exceeds the 5-year maximum.`);
  }
  return ms;
}

/** Compact human form of a duration in ms (round-trips common cases: `7d`, `24h`). */
export function formatDurationMs(ms: number): string {
  if (ms % WEEK_MS === 0) return `${ms / WEEK_MS}w`;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${Math.round(ms / 60000)}m`;
}

/**
 * Coerce a string/Date to a validated UTC ISO timestamp.
 * `maxFutureMs`/`maxPastMs` bound how far from `now` the value may fall —
 * logging yesterday's coffee is the core CRM use case, but a typo'd year
 * would poison recency scoring forever.
 */
export function toValidatedIso(
  value: string | Date,
  field: string,
  now: Date,
  bounds: { maxFutureMs?: number; maxPastMs?: number } = {}
): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new CrmError('invalid_input', `"${field}" is not a valid date: "${String(value)}".`);
  }
  if (bounds.maxFutureMs !== undefined && time > now.getTime() + bounds.maxFutureMs) {
    throw new CrmError(
      'invalid_input',
      `"${field}" is too far in the future (maximum ${Math.round(bounds.maxFutureMs / DAY_MS)} day(s) ahead).`
    );
  }
  if (bounds.maxPastMs !== undefined && time < now.getTime() - bounds.maxPastMs) {
    throw new CrmError(
      'invalid_input',
      `"${field}" is too far in the past (maximum ${Math.round(bounds.maxPastMs / (365 * DAY_MS))} years back).`
    );
  }
  return date.toISOString();
}

/** Trim + cap an optional text field. Empty strings normalize to null. */
export function optionalText(
  value: unknown,
  max: number,
  field: string
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new CrmError('invalid_input', `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new CrmError('invalid_input', `"${field}" must be ${max} characters or fewer.`);
  }
  return trimmed === '' ? null : trimmed;
}

/** UTC midnight of the given instant. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whole days between an ISO timestamp and `now`, floored at 0. */
export function daysSince(now: Date, iso: string): number {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor(ms / DAY_MS));
}

export { DAY_MS, HOUR_MS, WEEK_MS };
