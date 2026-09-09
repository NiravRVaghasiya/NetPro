import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import {
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
 * Body: { action: "complete" | "snooze" | "cancel", untilIso?, forMs? }.
 * Completing a recurring follow-up re-arms the next occurrence (returned as
 * `next`); snoozing needs `untilIso` or `forMs`.
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
    throw new CrmRequestError(
      400,
      `Unknown action "${action}". Expected "complete", "snooze", or "cancel".`
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
