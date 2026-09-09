// packages/core/src/workspaces/types.ts
// v3.0 Phase 1 — workspaces data model & multi-user auth.
// Roles are hierarchical: owner > admin > member > viewer.

export const MODULE_NAME = 'workspaces';

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_LIMITS = {
  name: 100,
  slug: 64,
} as const;

export type WorkspaceErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  token: string;
  role: WorkspaceRole;
  expiresAt: string;
  createdBy: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface WorkspaceScope {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: WorkspaceRole): number {
  switch (role) {
    case 'owner':
      return 4;
    case 'admin':
      return 3;
    case 'member':
      return 2;
    case 'viewer':
      return 1;
    default:
      return 0;
  }
}

export function canAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return roleRank(actual) >= roleRank(required);
}

export function resolveNow(now?: Date): Date {
  return now ?? new Date();
}
