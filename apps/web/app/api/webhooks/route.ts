/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership, requireScope } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { listWebhooks, createWebhook, WebhookError } from '@netpro/core/src/webhooks';

export async function GET(): Promise<Response> {
  try {
    const scope = await requireMembership('viewer');
    const webhooks = await listWebhooks(conn, scope);
    // Never return full secret in list? For v3.0 we mask: show last 4 only, but for admin we need secret once.
    // Here we return masked version: secret replaced with last 4.
    const masked = webhooks.map((wh) => ({
      ...wh,
      secret: `...${wh.secret.slice(-4)}`,
    }));
    return crmJson(masked);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const scope = await requireScope('admin');
    const body = await req.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const events = Array.isArray(body.events) ? body.events : [];
    const status = typeof body.status === 'string' ? body.status : 'enabled';
    if (!url) return crmJson({ error: 'url is required' }, 400);
    const wh = await createWebhook(conn, { url, events, status }, scope);
    // Return full secret once
    return crmJson(wh, 201);
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
