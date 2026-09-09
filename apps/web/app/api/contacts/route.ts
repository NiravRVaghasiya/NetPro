import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import { CRM_CONTACTS_SORTS, listCrmContacts, listFollowUps } from '@netpro/core/src/crm';
import { crmErrorResponse, crmJson, paginationParams } from '@/lib/crm-request';

/**
 * GET /api/contacts?limit=&offset=&sort=recent|score|name|follow-up
 * The CRM list: contacts with interaction stats and next pending follow-up,
 * plus the follow-up counts the page header renders.
 */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const scope = await requireScope();
    const { limit, offset } = paginationParams(p);
    const sortParam = p.get('sort');
    const sort = CRM_CONTACTS_SORTS.includes(sortParam as never)
      ? (sortParam as (typeof CRM_CONTACTS_SORTS)[number])
      : undefined;

    const [page, followUps] = await Promise.all([
      listCrmContacts(conn, { limit, offset, sort }, scope),
      // limit 1: only the counts are consumed here.
      listFollowUps(conn, { view: 'pending', limit: 1 }, scope),
    ]);
    return crmJson({ ...page, followUpCounts: followUps.counts });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
