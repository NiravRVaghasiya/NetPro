// packages/core/src/workspaces/service.ts
// Higher-level business rules: bootstrap owner handling, invite acceptance,
// role hierarchy, and break-glass owner protection.

import type { PgConn, SqliteConn } from '@netpro/db';
import {
  WorkspaceError,
  type WorkspaceRole,
  canAtLeast,
  resolveNow,
} from './types';
import {
  ensureBootstrapWorkspace,
  getMember,
  getMemberByUserId,
  listMembersByUserId,
  addMember,
  getInviteByToken,
  acceptInvite as acceptInviteRow,
} from './repository';
import { verifyInviteToken, isInviteExpired } from './tokens';

type Conn = SqliteConn | PgConn;

const BOOTSTRAP_WORKSPACE_ID = 'default';

/**
 * Ensure the bootstrap workspace exists and the owner (break-glass) is a member.
 * Called on startup and on first sign-in when no members exist.
 */
export async function ensureBootstrapWithOwner(
  conn: Conn,
  ownerUserId: string,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  if (!ownerUserId) throw new WorkspaceError('invalid_input', 'ownerUserId required');
  await ensureBootstrapWorkspace(conn);
  const existing = await getMember(conn, BOOTSTRAP_WORKSPACE_ID, ownerUserId);
  if (existing) {
    // Ensure owner role
    if (existing.role !== 'owner') {
      // Upgrade to owner if needed
      const { updateMemberRole } = await import('./repository');
      const updated = await updateMemberRole(conn, BOOTSTRAP_WORKSPACE_ID, ownerUserId, 'owner');
      return { workspaceId: BOOTSTRAP_WORKSPACE_ID, role: updated.role as WorkspaceRole };
    }
    return { workspaceId: BOOTSTRAP_WORKSPACE_ID, role: existing.role as WorkspaceRole };
  }
  // No membership yet — create owner membership
  const member = await addMember(conn, {
    workspaceId: BOOTSTRAP_WORKSPACE_ID,
    userId: ownerUserId,
    role: 'owner',
  });
  return { workspaceId: member.workspaceId, role: member.role as WorkspaceRole };
}

/**
 * Resolve a user's active membership (for single-workspace v3.0, first membership).
 * Returns null if not a member of any workspace.
 */
export async function resolveMembership(
  conn: Conn,
  userId: string,
): Promise<{ workspaceId: string; role: WorkspaceRole; userId: string } | null> {
  const members = await listMembersByUserId(conn, userId);
  if (members.length === 0) return null;
  // Prefer owner > admin > member > viewer, and bootstrap workspace first.
  const sorted = members.sort((a, b) => {
    if (a.workspaceId === BOOTSTRAP_WORKSPACE_ID && b.workspaceId !== BOOTSTRAP_WORKSPACE_ID) return -1;
    if (b.workspaceId === BOOTSTRAP_WORKSPACE_ID && a.workspaceId !== BOOTSTRAP_WORKSPACE_ID) return 1;
    return 0;
  });
  const first = sorted[0]!;
  return {
    workspaceId: first.workspaceId,
    role: first.role as WorkspaceRole,
    userId: first.userId,
  };
}

/**
 * Check if a user can sign in: either they are a member, or they hold a valid
 * invite token that can be accepted on sign-in.
 * For Phase 1, the web flow will accept invite via /invite/[token] page.
 */
export async function canSignIn(conn: Conn, userId: string): Promise<boolean> {
  const membership = await getMemberByUserId(conn, userId);
  return Boolean(membership);
}

/**
 * Accept an invite token for a user, creating membership.
 * Validates token signature, expiration, revocation, and acceptance.
 */
export async function acceptInviteByToken(
  conn: Conn,
  token: string,
  userId: string,
  secret: string,
  opts: { now?: Date } = {},
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  if (!token) throw new WorkspaceError('invalid_input', 'token required');
  if (!userId) throw new WorkspaceError('invalid_input', 'userId required');
  if (!secret) throw new WorkspaceError('invalid_input', 'secret required');

  const now = resolveNow(opts.now);

  // Verify cryptographic signature first (fast fail on tampered tokens)
  const verified = verifyInviteToken(token, secret);

  const invite = await getInviteByToken(conn, token);
  if (!invite) throw new WorkspaceError('not_found', 'Invite not found.');
  if (invite.id !== verified.inviteId) {
    throw new WorkspaceError('unauthorized', 'Invite id mismatch.');
  }
  if (invite.revokedAt) throw new WorkspaceError('unauthorized', 'Invite has been revoked.');
  if (invite.acceptedAt) throw new WorkspaceError('conflict', 'Invite already accepted.');
  if (isInviteExpired(invite.expiresAt, now)) {
    throw new WorkspaceError('unauthorized', 'Invite expired.');
  }

  // Check existing membership
  const existing = await getMember(conn, invite.workspaceId, userId);
  if (existing) {
    throw new WorkspaceError('conflict', 'User already a member.');
  }

  // Create membership
  await addMember(conn, {
    workspaceId: invite.workspaceId,
    userId,
    role: invite.role as WorkspaceRole,
  }, { now });

  // Mark invite accepted
  await acceptInviteRow(conn, invite.id, { now });

  // Audit log entry (best effort, non-fatal if fails)
  try {
    const id = crypto.randomUUID();
    const metadata = JSON.stringify({ inviteId: invite.id, role: invite.role });
    if (conn.dialect === 'sqlite') {
      await conn.db.insert(conn.schema.activityLog).values({
        id,
        workspaceId: invite.workspaceId,
        action: 'workspace.invite.accepted',
        entityType: 'workspace_invite',
        entityId: invite.id,
        metadata,
        createdAt: now.toISOString(),
      });
    } else {
      await conn.db.insert(conn.schema.activityLog).values({
        id,
        workspaceId: invite.workspaceId,
        action: 'workspace.invite.accepted',
        entityType: 'workspace_invite',
        entityId: invite.id,
        metadata,
        createdAt: now.toISOString(),
      });
    }
  } catch {
    // audit failure is non-fatal
  }

  return { workspaceId: invite.workspaceId, role: invite.role as WorkspaceRole };
}

/**
 * Ensure break-glass owner cannot be removed and last owner protection.
 */
export async function assertCanRemoveMember(
  conn: Conn,
  workspaceId: string,
  userIdToRemove: string,
  actorRole: WorkspaceRole,
  breakGlassOwnerId?: string,
): Promise<void> {
  if (breakGlassOwnerId && userIdToRemove === breakGlassOwnerId) {
    throw new WorkspaceError('forbidden', 'Cannot remove the break-glass owner.');
  }
  if (!canAtLeast(actorRole, 'admin')) {
    throw new WorkspaceError('forbidden', 'Only admins can remove members.');
  }
  // If removing an owner, ensure at least one other owner remains
  const { getWorkspaceMembers } = await import('./repository');
  const members = await getWorkspaceMembers(conn, workspaceId);
  const target = members.find((m) => m.userId === userIdToRemove);
  if (!target) throw new WorkspaceError('not_found', 'Member not found.');
  if (target.role === 'owner') {
    const ownerCount = members.filter((m) => m.role === 'owner').length;
    if (ownerCount <= 1) {
      throw new WorkspaceError('forbidden', 'Cannot remove the last owner.');
    }
  }
}

export async function assertCanChangeRole(
  conn: Conn,
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
  actorRole: WorkspaceRole,
  actorUserId: string,
  breakGlassOwnerId?: string,
): Promise<void> {
  if (breakGlassOwnerId && targetUserId === breakGlassOwnerId && newRole !== 'owner') {
    throw new WorkspaceError('forbidden', 'Cannot demote the break-glass owner.');
  }
  if (actorUserId === targetUserId && newRole !== actorRole) {
    // Self-demotion: only allowed if not last owner
    if (actorRole === 'owner') {
      const { getWorkspaceMembers } = await import('./repository');
      const members = await getWorkspaceMembers(conn, workspaceId);
      const ownerCount = members.filter((m) => m.role === 'owner').length;
      if (ownerCount <= 1 && newRole !== 'owner') {
        throw new WorkspaceError('forbidden', 'Cannot demote the last owner.');
      }
    }
  }
  if (!canAtLeast(actorRole, 'admin')) {
    throw new WorkspaceError('forbidden', 'Only admins can change roles.');
  }
  // Cannot promote above own rank
  const { roleRank } = await import('./types');
  if (roleRank(newRole) > roleRank(actorRole)) {
    throw new WorkspaceError('forbidden', 'Cannot assign a role higher than your own.');
  }
}
