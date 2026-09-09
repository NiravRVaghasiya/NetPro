import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import { getContactTimeline } from '@netpro/core/src/crm';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';

/**
 * GET /api/contacts/[id]
 * The contact-detail aggregate: profile, stats, interaction history, and
 * pending follow-ups. 404 for unknown or soft-deleted contacts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope();
    const timeline = await getContactTimeline(conn, id, {}, scope);
    if (!timeline) {
      return crmJson({ error: `No contact with id "${id}".`, code: 'not_found' }, 404);
    }
    return crmJson(timeline);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
