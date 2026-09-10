/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { testWebhook, WebhookError } from '@netpro/core/src/webhooks';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope('admin');
    const body = await req.json().catch(() => ({}));
    const event = typeof body.event === 'string' ? body.event : 'test.ping';
    const result = await testWebhook(conn, id, event, scope);
    return crmJson(result);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    if (error instanceof WebhookError) {
      const code = error.code === 'validation' ? 400 : error.code === 'not_found' ? 404 : 500;
      return crmJson({ error: error.message, code: error.code }, code);
    }
    return crmErrorResponse(error);
  }
}
