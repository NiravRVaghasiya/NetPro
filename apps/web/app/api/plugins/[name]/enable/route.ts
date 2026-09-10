/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { enablePlugin } from '@netpro/core/src/plugins/runtime';

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const scope = await requireMembership('admin');
    const body = await request.json().catch(() => ({}));
    if (!body.reviewed) {
      return crmJson({ error: 'You must confirm you have reviewed permissions (reviewed: true)' }, 400);
    }
    const { name } = await params;
    const updated = await enablePlugin(conn, name, scope);
    return crmJson(updated);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
