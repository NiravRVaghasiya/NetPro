/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership, requireScope } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { getWebhook, updateWebhook, deleteWebhook, WebhookError } from '@netpro/core/src/webhooks';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireMembership('viewer');
    const wh = await getWebhook(conn, id, scope);
    if (!wh) return crmJson({ error: 'Not found' }, 404);
    return crmJson({ ...wh, secret: `...${wh.secret.slice(-4)}` });
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope('admin');
    const body = await req.json().catch(() => ({}));
    const patch: { url?: string; events?: string[]; status?: any } = {};
    if (typeof body.url === 'string') patch.url = body.url.trim();
    if (Array.isArray(body.events)) patch.events = body.events;
    if (typeof body.status === 'string') patch.status = body.status;
    const wh = await updateWebhook(conn, id, patch, scope);
    return crmJson({ ...wh, secret: `...${wh.secret.slice(-4)}` });
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

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const scope = await requireScope('admin');
    await deleteWebhook(conn, id, scope);
    return crmJson({ ok: true });
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
