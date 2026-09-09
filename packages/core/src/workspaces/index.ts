// packages/core/src/workspaces/index.ts
// v3.0 Phase 1 — workspaces data model & multi-user auth.

export * from './types';
export * from './tokens';
export * as repository from './repository';
export * as service from './service';
export {
  ensureBootstrapWorkspace,
  getWorkspaceById,
  getWorkspaceBySlug,
  listWorkspaces,
  createWorkspace,
  getWorkspaceMembers,
  getMember,
  getMemberByUserId,
  listMembersByUserId,
  addMember,
  updateMemberRole,
  removeMember,
  createInvite,
  getInviteById,
  getInviteByToken,
  listInvites,
  acceptInvite,
  revokeInvite,
  deleteInvite,
} from './repository';
export {
  ensureBootstrapWithOwner,
  resolveMembership,
  canSignIn,
  acceptInviteByToken,
  assertCanRemoveMember,
  assertCanChangeRole,
} from './service';
