import { conn } from '@/lib/db';
import {
  markRecipientReplied,
  markRecipientSent,
  markRecipientSkipped,
} from '@netpro/core/src/campaigns';
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from '@/lib/crm-request';

type Params = { params: Promise<{ id: string; recipientId: string }> };

const ACTIONS = ['sent', 'replied', 'skipped'] as const;

/**
 * POST /api/campaigns/[id]/recipients/[recipientId]
 * Record a human-in-the-loop outcome for one recipient. Body:
 *   { action: "sent" | "replied" | "skipped", force? }
 *
 * "sent" logs an outbound email_sent interaction (feeding contact scoring) and
 * schedules the next drip step; it requires an active campaign and honours the
 * daily limit unless `force` is set. "replied" logs an inbound email_received
 * and cancels the remaining drip. "skipped" opts the recipient out without
 * logging any interaction.
 */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { id, recipientId } = await params;
  try {
    const body = await readCrmJson(request);
    const action = String(body.action ?? '');
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      throw new CrmRequestError(
        400,
        `Unknown action "${action}". Expected one of: ${ACTIONS.join(', ')}.`
      );
    }

    if (action === 'sent') {
      const result = await markRecipientSent(conn, id, recipientId, {
        force: body.force === true || body.force === 'true',
      });
      return crmJson(result);
    }
    if (action === 'replied') {
      return crmJson(await markRecipientReplied(conn, id, recipientId));
    }
    return crmJson(await markRecipientSkipped(conn, id, recipientId));
  } catch (error) {
    return crmErrorResponse(error);
  }
}
