/* eslint-disable @typescript-eslint/no-explicit-any */
// v3.0 Phase 1 — invite acceptance page.
// Accessible to any authenticated GitHub user (even without membership).
// Shows invite validity and allows acceptance, then redirects to dashboard.

import { auth } from '@/lib/auth';
import { conn } from '@/lib/db';
import { getInviteByToken } from '@netpro/core/src/workspaces';
import { verifyInviteToken, isInviteExpired } from '@netpro/core/src/workspaces';
import { getMembershipForUser } from '@/lib/workspaces';
import InviteClient from './client';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;

  let status: 'valid' | 'invalid' | 'already-member' | 'revoked' | 'expired' | 'accepted' = 'invalid';
  let inviteInfo: { workspaceId: string; role: string; expiresAt: string } | null = null;
  let errorMessage: string | null = null;

  if (!token) {
    errorMessage = 'Missing invite token.';
  } else {
    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '';
    try {
      verifyInviteToken(token, secret);
      const invite = await getInviteByToken(conn, token);
      if (!invite) {
        errorMessage = 'Invite not found.';
      } else if (invite.revokedAt) {
        status = 'revoked';
        errorMessage = 'This invite has been revoked.';
      } else if (invite.acceptedAt) {
        status = 'accepted';
        errorMessage = 'This invite has already been accepted.';
      } else if (isInviteExpired(invite.expiresAt)) {
        status = 'expired';
        errorMessage = 'This invite has expired.';
      } else {
        // Check if already member
        if (userId) {
          const membership = await getMembershipForUser(userId);
          if (membership && membership.workspaceId === invite.workspaceId) {
            status = 'already-member';
            errorMessage = 'You are already a member of this workspace.';
          } else {
            status = 'valid';
            inviteInfo = {
              workspaceId: invite.workspaceId,
              role: invite.role,
              expiresAt: invite.expiresAt,
            };
          }
        } else {
          status = 'valid';
          inviteInfo = {
            workspaceId: invite.workspaceId,
            role: invite.role,
            expiresAt: invite.expiresAt,
          };
        }
      }
    } catch (e: unknown) {
      errorMessage = (e as Error).message || 'Invalid invite token.';
    }
  }

  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold mb-4">Workspace Invite</h1>
      <InviteClient token={token} status={status} inviteInfo={inviteInfo} errorMessage={errorMessage} />
    </div>
  );
}
