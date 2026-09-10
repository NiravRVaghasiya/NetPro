// packages/server/src/routes/calendar-events.ts
//
// GET /api/events  — calendar events (the web's /events, not SSE)
// GET /api/events/:id
//
// Distinct from GET /api/events when Accept: text/event-stream (SSE).
// Orchestrates @netpro/core/events — never reimplements matching.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { listEvents, getEvent } from '@netpro/core/src/events';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type CalendarEventsDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

export async function handleListCalendarEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CalendarEventsDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const limit = Number(url.searchParams.get('limit') ?? '25');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  try {
    const page = await listEvents(deps.conn, {
      limit: Number.isFinite(limit) ? limit : 25,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    sendJson(res, 200, page);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    const status = code === 'invalid_input' ? 400 : 500;
    sendJson(res, status, { error: msg, code });
  }
}

export async function handleGetCalendarEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CalendarEventsDeps,
  id: string
): Promise<void> {
  if (!id) {
    sendJson(res, 400, { error: 'Event id is required.' });
    return;
  }
  try {
    const event = await getEvent(deps.conn, id);
    if (!event) {
      sendJson(res, 404, { error: `No event with id "${id}".`, code: 'not_found' });
      return;
    }
    sendJson(res, 200, event);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: msg });
  }
}
