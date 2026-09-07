import { conn } from '@/lib/db';
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
    const followUp = await getFollowUp(conn, id);
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
    const body = await readCrmJson(request);
    const action = String(body.action ?? '');

    if (action === 'complete') {
      return crmJson(await completeFollowUp(conn, id));
    }
    if (action === 'cancel') {
      return crmJson(await cancelFollowUp(conn, id));
    }
    if (action === 'snooze') {
      const forMs = body.forMs;
      return crmJson(
        await snoozeFollowUp(conn, id, {
          untilIso: (body.untilIso as string | undefined) ?? undefined,
          forMs: typeof forMs === 'number' && Number.isFinite(forMs) ? forMs : undefined,
        })
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
