/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireAuth } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { acceptInviteByToken } from '@netpro/core/src/workspaces';

export async function POST(request: Request): Promise<Response> {
  try {
    const { userId } = await requireAuth();
    const body = await request.json().catch(() => ({}));
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return crmJson({ error: 'token required' }, 400);

    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
    if (!secret) return crmJson({ error: 'Server misconfigured' }, 500);

    const result = await acceptInviteByToken(conn, token, userId, secret);
    return crmJson({ ok: true, workspaceId: result.workspaceId, role: result.role });
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
