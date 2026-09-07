// GET / DELETE /api/events/[id]
//
// The detail view: who in your network was there, what they do, and the
// attendee lines the last import could not resolve (kept for manual linking
// rather than thrown away). DELETE removes the event and its attendance rows —
// the edges it produced are facts you confirm on /edges, so they stay.
import { conn } from '@/lib/db';
import { getEvent, removeEvent } from '@netpro/core/src/events';
import { CrmRequestError, crmErrorResponse, crmJson } from '@/lib/crm-request';
import { resolveOptionalEvent } from '@/lib/events-request';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await context.params;
    const event = await resolveOptionalEvent(conn, id);
    if (!event) throw new CrmRequestError(404, 'An event id or name is required.');
    const detail = await getEvent(conn, event.id);
    if (!detail) return crmJson({ error: `No event with id "${event.id}".`, code: 'not_found' }, 404);
    return crmJson(detail);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await context.params;
    const event = await resolveOptionalEvent(conn, id);
    if (!event) throw new CrmRequestError(404, 'An event id or name is required.');
    const removed = await removeEvent(conn, event.id);
    return crmJson({ removed });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
