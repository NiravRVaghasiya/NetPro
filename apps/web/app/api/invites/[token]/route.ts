import { conn } from '@/lib/db';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { getInviteByToken } from '@netpro/core/workspaces';
import { verifyInviteToken, isInviteExpired } from '@netpro/core/workspaces';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    if (!token) return crmJson({ error: 'token required' }, 400);
    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
    if (!secret) return crmJson({ error: 'Server misconfigured' }, 500);

    // Verify signature first
    try {
      verifyInviteToken(token, secret);
    } catch (e: any) {
      return crmJson({ error: e.message, valid: false }, 400);
    }

    const invite = await getInviteByToken(conn, token);
    if (!invite) return crmJson({ error: 'Invite not found', valid: false }, 404);
    if (invite.revokedAt) return crmJson({ error: 'Invite revoked', valid: false }, 410);
    if (invite.acceptedAt) return crmJson({ error: 'Invite already accepted', valid: false }, 410);
    if (isInviteExpired(invite.expiresAt)) return crmJson({ error: 'Invite expired', valid: false }, 410);

    return crmJson({
      valid: true,
      invite: {
        id: invite.id,
        workspaceId: invite.workspaceId,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
