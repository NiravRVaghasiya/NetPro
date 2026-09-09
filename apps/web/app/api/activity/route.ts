import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import { listActivityLog } from '@netpro/core/src/crm';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';

/**
 * GET /api/activity?limit=&offset=&action=&entityType=&userId=&from=&to=
 * Admin+ only — paginated activity_log reader, filterable by action prefix,
 * entity type, member, and date.
 */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const scope = await requireScope('admin');
    const limit = Number(p.get('limit') ?? '50');
    const offset = Number(p.get('offset') ?? '0');
    const action = p.get('action')?.trim() || undefined;
    const entityType = p.get('entityType')?.trim() || undefined;
    const userId = p.get('userId')?.trim() || undefined;
    const from = p.get('from')?.trim() || undefined;
    const to = p.get('to')?.trim() || undefined;

    const page = await listActivityLog(
      conn,
      {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
        actionPrefix: action,
        entityType,
        userId,
        from,
        to,
      },
      scope
    );
    return crmJson(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
