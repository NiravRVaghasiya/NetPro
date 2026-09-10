/* eslint-disable @typescript-eslint/no-explicit-any */
import { crmJson } from '@/lib/crm-request';
import { WEBHOOK_EVENTS, WEBHOOK_RECEIVER_RECIPES } from '@netpro/core/src/webhooks';
import { requireMembership } from '@/lib/authz';

export async function GET(): Promise<Response> {
  try {
    await requireMembership('viewer');
    return crmJson({ events: WEBHOOK_EVENTS, recipes: WEBHOOK_RECEIVER_RECIPES });
  } catch (e: any) {
    if (e?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if (e?.status === 403) return crmJson({ error: e.message }, 403);
    return crmJson({ error: 'Internal' }, 500);
  }
}
