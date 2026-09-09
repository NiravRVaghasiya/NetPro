/* eslint-disable @typescript-eslint/no-explicit-any */
// v3.0 Phase 1 — team admin page (owner/admin).
// Lists members, invites, and allows invite generation / revocation.
// For v3.0 single-workspace UI, this is the only workspace management surface.

import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { getWorkspaceMembers, listInvites } from '@netpro/core/src/workspaces';
import TeamClient from './client';

export const metadata = {
  title: 'Team — NetPro',
};

export default async function TeamSettingsPage() {
  const ctx = await requireMembership('admin');
  const [members, invites] = await Promise.all([
    getWorkspaceMembers(conn, ctx.workspaceId),
    listInvites(conn, ctx.workspaceId),
  ]);

  // Resolve user details for members
  const userIds = members.map((m) => m.userId);
  let users: Array<{ id: string; name: string | null; email: string; image: string | null }> = [];
  if (userIds.length > 0) {
    const { inArray } = await import('drizzle-orm');
    const rows =
      conn.dialect === 'sqlite'
        ? await conn.db.select().from(conn.schema.users).where(inArray(conn.schema.users.id, userIds))
        : await conn.db.select().from(conn.schema.users).where(inArray(conn.schema.users.id, userIds));
    users = rows as any;
  }

  const membersWithUsers = members.map((m) => ({
    ...m,
    user: users.find((u) => u.id === m.userId) ?? null,
  }));

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-2">Team</h1>
      <p className="text-sm text-slate-500 mb-6">
        Manage workspace members and invites. Only admins can create invites and change roles. The break-glass owner
        (NETPRO_OWNER_GITHUB_ID) cannot be removed.
      </p>
      <TeamClient
        workspaceId={ctx.workspaceId}
        currentUserId={ctx.userId}
        currentRole={ctx.role}
        members={membersWithUsers}
        invites={invites}
      />
    </div>
  );
}
