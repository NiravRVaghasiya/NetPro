// POST /api/events/[id]/match
//
// Re-run matching for one event against the network as it is *now* — this is
// how a contact you imported after the conference file gets linked without
// re-importing anything. Preview by default (`{ "apply": true }` writes), and
// the response names every match tier so the UI can explain why a line was
// left alone.
import { conn } from '@/lib/db';
import { matchEventAttendees } from '@netpro/core/src/events';
import { CrmRequestError, crmErrorResponse, crmJson, readCrmJson } from '@/lib/crm-request';
import { resolveOptionalEvent } from '@/lib/events-request';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await context.params;
    const event = await resolveOptionalEvent(conn, id);
    if (!event) throw new CrmRequestError(404, 'An event id or name is required.');
    const body = await readCrmJson(request).catch(() => ({}) as Record<string, unknown>);
    const result = await matchEventAttendees(conn, event.id, {
      apply: body.apply === true,
      includeReview: body.review === true,
      edges: body.edges === undefined ? true : body.edges !== false,
    });
    return crmJson(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
