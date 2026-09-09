// packages/core/src/workspaces/tokens.ts
// HMAC-signed, expiring invite tokens — same construction as the ?v= view tokens.
// Token format: base64url(inviteId|expiresAtMs|hmac)
// hmac = HMAC-SHA256(secret, inviteId|expiresAtMs)
// Verification is timing-safe; expiration is checked; secret is NEXTAUTH_SECRET.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { WorkspaceError } from './types';

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Create a signed invite token.
 * @param inviteId - the invite row id
 * @param expiresAt - expiration date
 * @param secret - HMAC secret (NEXTAUTH_SECRET)
 */
export function createInviteToken(
  inviteId: string,
  expiresAt: Date,
  secret: string,
): string {
  if (!inviteId) throw new WorkspaceError('invalid_input', 'inviteId is required.');
  if (!secret) throw new WorkspaceError('invalid_input', 'secret is required.');
  const exp = String(expiresAt.getTime());
  const payload = `${inviteId}|${exp}`;
  const sig = hmac(secret, payload);
  return base64UrlEncode(`${payload}|${sig}`);
}

export interface VerifiedInviteToken {
  inviteId: string;
  expiresAt: Date;
}

export function verifyInviteToken(token: string, secret: string): VerifiedInviteToken {
  if (!token || typeof token !== 'string') {
    throw new WorkspaceError('invalid_input', 'Invalid invite token.');
  }
  if (!secret) throw new WorkspaceError('invalid_input', 'secret is required.');
  let decoded: string;
  try {
    decoded = base64UrlDecode(token);
  } catch {
    throw new WorkspaceError('invalid_input', 'Invalid invite token format.');
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) {
    throw new WorkspaceError('invalid_input', 'Invalid invite token format.');
  }
  const [inviteId, expStr, sig] = parts;
  if (!inviteId || !expStr || !sig) {
    throw new WorkspaceError('invalid_input', 'Invalid invite token format.');
  }
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) {
    throw new WorkspaceError('invalid_input', 'Invalid invite token expiration.');
  }
  const payload = `${inviteId}|${expStr}`;
  const expected = hmac(secret, payload);
  // timing-safe compare of hex strings
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WorkspaceError('unauthorized', 'Invalid invite token signature.');
  }
  const expiresAt = new Date(expMs);
  if (expiresAt.getTime() <= Date.now()) {
    throw new WorkspaceError('unauthorized', 'Invite token expired.');
  }
  return { inviteId, expiresAt };
}

export function isInviteExpired(expiresAt: string | Date, now = new Date()): boolean {
  const exp = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  return exp.getTime() <= now.getTime();
}
