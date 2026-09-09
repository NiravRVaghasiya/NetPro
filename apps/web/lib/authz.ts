/* eslint-disable @typescript-eslint/no-explicit-any */
// apps/web/lib/authz.ts
// v3.0 Phase 1 — authorization helpers for workspace-scoped routes.
// Every owner-only route now also checks workspace membership and role.

import { auth } from './auth';
import { getMembershipForUser } from './workspaces';
import type { WorkspaceRole, WorkspaceScope } from '@netpro/core/src/workspaces';
import { canAtLeast } from '@netpro/core/src/workspaces';

export interface AuthContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export async function requireAuth(): Promise<{ userId: string }> {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  return { userId };
}

export async function requireMembership(minRole: WorkspaceRole = 'viewer'): Promise<AuthContext> {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  const membership = await getMembershipForUser(userId);
  if (!membership) {
    throw Object.assign(new Error('Forbidden: not a workspace member'), { status: 403 });
  }
  if (!canAtLeast(membership.role, minRole)) {
    throw Object.assign(new Error(`Forbidden: requires ${minRole} role`), { status: 403 });
  }
  return {
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
  };
}

/**
 * v3.0 Phase 2 — the workspace-principal a scoped core function needs. Every
 * route that touches data passes the authenticated principal's scope down into
 * the core query; a request never supplies its own workspace id.
 */
export async function requireScope(minRole: WorkspaceRole = 'viewer'): Promise<WorkspaceScope> {
  const { userId, workspaceId, role } = await requireMembership(minRole);
  return { userId, workspaceId, role };
}
