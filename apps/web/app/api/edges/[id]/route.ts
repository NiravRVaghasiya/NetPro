import { conn } from '@/lib/db';
import { removeEdge, resolveEdgeId, setEdgeStatus } from '@netpro/core/src/graph';
import { crmErrorResponse, crmJson, readCrmJson } from '@/lib/crm-request';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: raw } = await context.params;
    const id = await resolveEdgeId(conn, raw);
    const body = await readCrmJson(request);
    const action = String(body.action ?? body.status ?? '');
    if (action !== 'confirmed' && action !== 'rejected' && action !== 'confirm' && action !== 'reject') {
      return crmJson({ error: 'action must be confirm/confirmed or reject/rejected.', code: 'invalid_input' }, 400);
    }
    const status = action.startsWith('confirm') ? 'confirmed' : 'rejected';
    const edge = await setEdgeStatus(conn, id, status);
    return crmJson({ edge });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: raw } = await context.params;
    const id = await resolveEdgeId(conn, raw);
    const edge = await removeEdge(conn, id);
    return crmJson({ edge });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
