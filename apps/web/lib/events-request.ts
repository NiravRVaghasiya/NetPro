// apps/web/lib/events-request.ts
//
// Shared parsing for the v2.0 Phase 6 events routes. The proxy is the
// ownership boundary (all /api/* require the owner session); these helpers
// cover what the boundary does not: bounded list parameters, a bounded CSV
// upload, and event/contact selectors that answer the way the graph and
// skills routes do — unknown → 404, ambiguous → 400 — via the shared
// resolvers, so every surface in the app speaks the same error language.
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveContactRef, type ContactRef } from '@netpro/core/src/ai';
import { resolveEventRef, type EventRecord } from '@netpro/core/src/events';
import { CrmRequestError } from './crm-request';

/** 1 MiB is ~10k attendee lines — generous for a conference export. */
export const MAX_EVENT_CSV_BYTES = 1024 * 1024;

export function boundedInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function boundedText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new CrmRequestError(400, `${field} must be a string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new CrmRequestError(400, `${field} must be ${max} characters or fewer.`);
  }
  return trimmed === '' ? null : trimmed;
}

export const boundedName = (raw: unknown, field: string): string | null => boundedText(raw, field, 200);

/** `?query=&upcoming=&limit=&offset=` → core list options. */
export function eventListParams(sp: URLSearchParams): {
  query?: string;
  upcoming?: boolean;
  limit: number;
  offset: number;
} {
  const upcoming = sp.get('upcoming');
  return {
    query: boundedText(sp.get('query'), 'query', 200) ?? undefined,
    upcoming: upcoming === null ? undefined : upcoming === '1' || upcoming === 'true',
    limit: boundedInt(sp.get('limit'), 50, 1, 100),
    offset: boundedInt(sp.get('offset'), 0, 0, 100_000),
  };
}

/**
 * Resolve an optional event selector (id or exact name). Ambiguity is 400 —
 * the caller asked for something NetPro refuses to guess — and unknown is 404.
 */
export async function resolveOptionalEvent(
  conn: SqliteConn | PgConn,
  selector: string | null | undefined
): Promise<EventRecord | null> {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 320) throw new CrmRequestError(400, 'event selector is too long.');
  try {
    return await resolveEventRef(conn, trimmed);
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith('Ambiguous')) throw new CrmRequestError(400, message);
    throw new CrmRequestError(404, message);
  }
}

/** Same contract for the contact half of an attendance row. */
export async function resolveOptionalContact(
  conn: SqliteConn | PgConn,
  selector: string | null | undefined
): Promise<ContactRef | null> {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 320) throw new CrmRequestError(400, 'contact selector is too long.');
  try {
    return await resolveContactRef(conn, trimmed);
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith('Ambiguous')) throw new CrmRequestError(400, message);
    throw new CrmRequestError(404, message);
  }
}

/** Read a bounded CSV upload (`multipart/form-data`, field `file`). */
export async function readEventCsv(request: Request): Promise<string> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new CrmRequestError(400, 'Expected a multipart/form-data upload with a "file" field.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new CrmRequestError(400, 'A CSV file is required.');
  }
  if (file.size > MAX_EVENT_CSV_BYTES) {
    throw new CrmRequestError(413, `CSV must be ${MAX_EVENT_CSV_BYTES / 1024} KiB or smaller.`);
  }
  return file.text();
}

/** `?dryRun=1` / `{ "dryRun": true }` — previews write nothing. */
export function dryRunFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === '1' || raw.toLowerCase() === 'true';
  return false;
}
