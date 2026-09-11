// packages/server/src/routes/contacts.ts
//
// GET /api/contacts
// GET /api/contacts/:id
// POST /api/contacts
//
// Orchestrates @netpro/core CRM — no business logic here, only HTTP
// plumbing (validation, pagination, error mapping).
//
// POST creates one person from a pasted LinkedIn profile URL (`{ linkedinUrl,
// fullName? }` → 201 `{ status: "created", contact }`, or 200
// `{ status: "exists", contact }` when the profile is already known — never
// a silent duplicate). `{ linkedinUrl, dryRun: true }` validates +
// duplicate-checks without writing, for the UI's "Checking profile…" state.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { listCrmContacts, getContactTimeline } from '@netpro/core/src/crm';
import { addPersonFromLinkedIn, checkLinkedInImport } from '@netpro/core/src/crm/add-person';
import { CrmError } from '@netpro/core/src/crm';
import { GraphError } from '@netpro/core/src/graph';
import type { PgConn, SqliteConn } from '@netpro/db';
import { sendJson, readJsonBody } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type ContactsDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

const SORTS = ['recent', 'score', 'name', 'follow-up'] as const;

function numParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function errorStatus(err: unknown): number {
  if (err instanceof CrmError) {
    return err.code === 'not_found' ? 404 : err.code === 'invalid_input' ? 400 : 409;
  }
  if (err instanceof GraphError) {
    return err.code === 'not_found' ? 404 : err.code === 'invalid_input' ? 400 : 409;
  }
  const s = (err as { status?: unknown })?.status;
  if (s === 401 || s === 403) return s as number;
  return 500;
}

export async function handleListContacts(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContactsDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.searchParams;
  const limit = numParam(p.get('limit'), 25);
  const offset = numParam(p.get('offset'), 0);
  const sortParam = p.get('sort');
  const sort = (SORTS as readonly string[]).includes(sortParam ?? '') ? (sortParam as typeof SORTS[number]) : undefined;

  try {
    // Workspace scope is not multi-tenant on local server — the single
    // install's default workspace is implicit. Passing undefined keeps the
    // bootstrap guarantee (all contacts) without requiring a session.
    const page = await listCrmContacts(deps.conn, { limit, offset, sort });
    // Add follow-up counts? web /api/contacts also returns followUpCounts;
    // keep it lightweight here — the web dashboard can fetch separately.
    sendJson(res, 200, { ...page, contacts: page.contacts, total: page.total, limit: page.limit, offset: page.offset, sort: page.sort });
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

export async function handleGetContact(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContactsDeps,
  id: string
): Promise<void> {
  if (!id || id.trim() === '') {
    sendJson(res, 400, { error: 'Contact id is required.' });
    return;
  }
  try {
    const timeline = await getContactTimeline(deps.conn, id, {});
    if (!timeline) {
      sendJson(res, 404, { error: `No contact with id "${id}".`, code: 'not_found' });
      return;
    }
    sendJson(res, 200, timeline);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}

export async function handleCreateContact(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContactsDeps
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const linkedinUrl = typeof body.linkedinUrl === 'string' ? body.linkedinUrl : '';
  const fullName = typeof body.fullName === 'string' ? body.fullName : undefined;
  const dryRun = body.dryRun === true;

  try {
    // Workspace scope stays implicit (bootstrap `default`), exactly like the
    // list route — the single-install server has no session to scope from,
    // and no request field may widen the workspace.
    if (dryRun) {
      const check = await checkLinkedInImport(deps.conn, linkedinUrl);
      sendJson(res, 200, {
        profile: {
          username: check.profile.username,
          normalizedUrl: check.profile.normalizedUrl,
        },
        exists: check.existing !== null,
        contact: check.existing,
      });
      return;
    }
    const result = await addPersonFromLinkedIn(deps.conn, { linkedinUrl, fullName });
    sendJson(res, result.status === 'created' ? 201 : 200, {
      status: result.status,
      contact: result.contact,
      profile: {
        username: result.profile.username,
        normalizedUrl: result.profile.normalizedUrl,
      },
    });
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message, code: (error as { code?: string })?.code });
  }
}
