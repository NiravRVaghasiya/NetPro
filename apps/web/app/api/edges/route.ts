import { conn } from '@/lib/db';
import {
  addEdge,
  countEdges,
  listEdges,
  recordEventAttendance,
} from '@netpro/core/src/graph';
import {
  crmErrorResponse,
  crmJson,
  paginationParams,
  readCrmJson,
} from '@/lib/crm-request';

/** GET /api/edges?contactId=&relation=&status=&limit=&offset= */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const { limit, offset } = paginationParams(p);
    const contactId = p.get('contactId')?.trim() || undefined;
    const relation = p.get('relation')?.trim() || undefined;
    const status = p.get('status')?.trim() || undefined;
    const [edges, total] = await Promise.all([
      listEdges(conn, { contactId, relation, status, limit, offset }),
      countEdges(conn, { contactId, relation, status }),
    ]);
    return crmJson({ edges, total, limit, offset });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * POST /api/edges
 * Body: { sourceId, targetId, relation?, ... } OR { contactId, eventName } for
 * the "also met at…" producer.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readCrmJson(request);
    if (typeof body.eventName === 'string' && body.eventName.trim()) {
      const result = await recordEventAttendance(conn, {
        contactId: String(body.contactId ?? ''),
        eventName: body.eventName,
        location: (body.location as string | null | undefined) ?? undefined,
      });
      return crmJson(result, 201);
    }
    const result = await addEdge(conn, {
      sourceId: String(body.sourceId ?? ''),
      targetId: String(body.targetId ?? ''),
      relation: (body.relation as string | undefined) ?? undefined,
      source: (body.source as string | undefined) ?? 'manual',
      context: (body.context as string | null | undefined) ?? undefined,
      confidence: body.confidence as number | undefined,
      status: (body.status as string | undefined) ?? 'confirmed',
    });
    return crmJson({ edge: result.edge, created: result.created }, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
