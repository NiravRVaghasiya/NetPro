/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { revokeInvite, getInviteById } from '@netpro/core/src/workspaces';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const { id } = await params;
    const invite = await getInviteById(conn, id);
    if (!invite) return crmJson({ error: 'Invite not found' }, 404);
    if (invite.workspaceId !== ctx.workspaceId) return crmJson({ error: 'Invite not in this workspace' }, 404);

    await revokeInvite(conn, id);

    try {
      const auditId = crypto.randomUUID();
      const now = new Date().toISOString();
      if (conn.dialect === 'sqlite') {
        await conn.db.insert(conn.schema.activityLog).values({
          id: auditId,
          workspaceId: ctx.workspaceId,
          action: 'workspace.invite.revoked',
          entityType: 'workspace_invite',
          entityId: id,
          metadata: JSON.stringify({}),
          createdAt: now,
        });
      } else {
        await conn.db.insert(conn.schema.activityLog).values({
          id: auditId,
          workspaceId: ctx.workspaceId,
          action: 'workspace.invite.revoked',
          entityType: 'workspace_invite',
          entityId: id,
          metadata: JSON.stringify({}),
          createdAt: now,
        });
      }
    } catch {
      /* audit best-effort */
    }

    return crmJson({ ok: true });
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
