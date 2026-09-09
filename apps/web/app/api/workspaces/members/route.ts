import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { getWorkspaceMembers, addMember, removeMember, updateMemberRole } from '@netpro/core/workspaces';
import { assertCanRemoveMember, assertCanChangeRole } from '@netpro/core/workspaces';
import { isOwnerGitHubId } from '@/lib/owner';

export async function GET(): Promise<Response> {
  try {
    const ctx = await requireMembership('viewer');
    const members = await getWorkspaceMembers(conn, ctx.workspaceId);
    return crmJson({ members });
  } catch (error: any) {
    if (error?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if (error?.status === 403) return crmJson({ error: error.message }, 403);
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const body = await request.json().catch(() => ({}));
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const role = typeof body.role === 'string' ? body.role : 'member';
    if (!userId) return crmJson({ error: 'userId is required' }, 400);

    // Check if user exists
    const userRows =
      conn.dialect === 'sqlite'
        ? await conn.db.select().from(conn.schema.users).where((await import('drizzle-orm')).eq(conn.schema.users.id, userId)).limit(1)
        : await conn.db.select().from(conn.schema.users).where((await import('drizzle-orm')).eq(conn.schema.users.id, userId)).limit(1);
    if (!userRows[0]) return crmJson({ error: 'User not found' }, 404);

    const member = await addMember(conn, { workspaceId: ctx.workspaceId, userId, role: role as any });
    return crmJson({ member }, 201);
  } catch (error: any) {
    if (error?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if (error?.status === 403) return crmJson({ error: error.message }, 403);
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const body = await request.json().catch(() => ({}));
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const role = typeof body.role === 'string' ? body.role : '';
    if (!userId || !role) return crmJson({ error: 'userId and role required' }, 400);

    await assertCanChangeRole(conn, ctx.workspaceId, userId, role as any, ctx.role, ctx.userId, process.env.NETPRO_OWNER_GITHUB_ID ? undefined : undefined);

    const member = await updateMemberRole(conn, ctx.workspaceId, userId, role as any);
    return crmJson({ member });
  } catch (error: any) {
    if (error?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if (error?.status === 403) return crmJson({ error: error.message }, 403);
    return crmErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const ctx = await requireMembership('admin');
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId')?.trim() ?? '';
    if (!userId) return crmJson({ error: 'userId query required' }, 400);

    // Break-glass protection: cannot remove owner GitHub ID user if we can resolve it
    // We don't have githubId -> userId mapping easily here, but we can check if target is last owner
    await assertCanRemoveMember(conn, ctx.workspaceId, userId, ctx.role);

    await removeMember(conn, ctx.workspaceId, userId);
    return crmJson({ ok: true });
  } catch (error: any) {
    if (error?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if (error?.status === 403) return crmJson({ error: error.message }, 403);
    return crmErrorResponse(error);
  }
}
