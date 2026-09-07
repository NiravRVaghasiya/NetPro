import { conn } from '@/lib/db';
import {
  addRecipients,
  renderCampaign,
  setCampaignStatus,
  updateCampaignDraft,
  CAMPAIGN_STATUSES,
} from '@netpro/core/src/campaigns';
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from '@/lib/crm-request';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/campaigns/[id]
 * The full campaign render: the message sequence, every recipient with its
 * personalized draft, and the daily-limit meter. 404 when unknown.
 */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const render = await renderCampaign(conn, id);
    if (!render) {
      return crmJson({ error: `No campaign with id "${id}".`, code: 'not_found' }, 404);
    }
    return crmJson(render);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * PATCH /api/campaigns/[id]
 * Campaign-level mutations, chosen by `action`:
 *   - "status"         { status } → lifecycle transition (active/paused/…)
 *   - "update"         { name?, description?, template?, steps?, dailyLimit?, sendFrom? }
 *                       → edit a draft (frozen once active)
 *   - "add-recipients" { recipients: { contactIds? | search? } } → grow the snapshot
 */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const body = await readCrmJson(request);
    const action = String(body.action ?? '');

    if (action === 'status') {
      const status = String(body.status ?? '');
      if (!CAMPAIGN_STATUSES.includes(status as never)) {
        throw new CrmRequestError(
          400,
          `Unknown status "${status}". Expected one of: ${CAMPAIGN_STATUSES.join(', ')}.`
        );
      }
      return crmJson(await setCampaignStatus(conn, id, status));
    }

    if (action === 'update') {
      const updated = await updateCampaignDraft(conn, id, {
        name: body.name,
        description: body.description,
        sendFrom: body.sendFrom,
        dailyLimit: body.dailyLimit,
        template: body.template,
        steps: body.steps,
      });
      return crmJson(updated);
    }

    if (action === 'add-recipients') {
      const recipients = body.recipients;
      if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients)) {
        throw new CrmRequestError(
          400,
          'add-recipients requires a "recipients" object ({ contactIds? } or { search? }).'
        );
      }
      const result = await addRecipients(
        conn,
        id,
        recipients as { contactIds?: string[]; search?: Record<string, unknown> }
      );
      return crmJson(result);
    }

    throw new CrmRequestError(
      400,
      `Unknown action "${action}". Expected "status", "update", or "add-recipients".`
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
