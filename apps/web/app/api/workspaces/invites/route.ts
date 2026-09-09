/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { createInvite, listInvites } from '@netpro/core/src/workspaces';

export async function GET(): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const invites = await listInvites(conn, ctx.workspaceId);
    return crmJson({ invites });
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const body = await request.json().catch(() => ({}));
    const role = typeof body.role === 'string' ? body.role : 'member';
    const expiresInDays = typeof body.expiresInDays === 'number' ? body.expiresInDays : 7;
    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
    if (!secret) return crmJson({ error: 'Server misconfigured: missing secret' }, 500);

    const { invite, rawToken } = await createInvite(conn, {
      workspaceId: ctx.workspaceId,
      role: role as any,
      createdBy: ctx.userId,
      expiresInDays,
      secret,
    });

    // Audit log
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      if (conn.dialect === 'sqlite') {
        await conn.db.insert(conn.schema.activityLog).values({
          id,
          workspaceId: ctx.workspaceId,
          action: 'workspace.invite.created',
          entityType: 'workspace_invite',
          entityId: invite.id,
          metadata: JSON.stringify({ role }),
          createdAt: now,
        });
      } else {
        await conn.db.insert(conn.schema.activityLog).values({
          id,
          workspaceId: ctx.workspaceId,
          action: 'workspace.invite.created',
          entityType: 'workspace_invite',
          entityId: invite.id,
          metadata: JSON.stringify({ role }),
          createdAt: now,
        });
      }
    } catch {
      /* audit best-effort */
    }

    return crmJson({ invite, token: rawToken, url: `/invite/${rawToken}` }, 201);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
