import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import {
  assignFollowUp,
  cancelFollowUp,
  completeFollowUp,
  getFollowUp,
  snoozeFollowUp,
} from '@netpro/core/src/crm';
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from '@/lib/crm-request';

/** GET /api/follow-ups/[id] — one follow-up with its contact name. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope();
    const followUp = await getFollowUp(conn, id, scope);
    if (!followUp) {
      return crmJson({ error: `No follow-up with id "${id}".`, code: 'not_found' }, 404);
    }
    return crmJson(followUp);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * PATCH /api/follow-ups/[id]
 * Body: { action: "complete" | "snooze" | "cancel" | "assign", untilIso?, forMs?, assignedTo? }.
 * Completing a recurring follow-up re-arms the next occurrence (returned as
 * `next`); snoozing needs `untilIso` or `forMs`; assign needs `assignedTo`
 * (user id or null to unassign).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope();
    const body = await readCrmJson(request);
    const action = String(body.action ?? '');

    if (action === 'complete') {
      return crmJson(await completeFollowUp(conn, id, {}, scope));
    }
    if (action === 'cancel') {
      return crmJson(await cancelFollowUp(conn, id, {}, scope));
    }
    if (action === 'snooze') {
      const forMs = body.forMs;
      return crmJson(
        await snoozeFollowUp(
          conn,
          id,
          {
            untilIso: (body.untilIso as string | undefined) ?? undefined,
            forMs: typeof forMs === 'number' && Number.isFinite(forMs) ? forMs : undefined,
          },
          {},
          scope,
        )
      );
    }
    if (action === 'assign') {
      const assignedTo =
        body.assignedTo === null ? null : (body.assignedTo as string | undefined) ?? null;
      return crmJson(await assignFollowUp(conn, id, assignedTo, {}, scope));
    }
    throw new CrmRequestError(
      400,
      `Unknown action "${action}". Expected "complete", "snooze", "cancel", or "assign".`
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
