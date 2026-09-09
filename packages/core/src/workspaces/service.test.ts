import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { ensureBootstrapWorkspace, addMember, createInvite, getMember } from './repository';
import { ensureBootstrapWithOwner, resolveMembership, acceptInviteByToken } from './service';
import { WorkspaceError } from './types';

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});

afterEach(() => {
  fixture.sqlite.close();
});

function seedUser(id: string) {
  fixture.conn.db
    .insert(fixture.conn.schema.users)
    .values({ id, email: `${id}@example.com`, name: id })
    .run();
}

describe('workspaces service (Phase 1)', () => {
  it('ensureBootstrapWithOwner creates owner membership and upgrades', async () => {
    seedUser('owner1');
    const res = await ensureBootstrapWithOwner(fixture.conn, 'owner1');
    expect(res.workspaceId).toBe('default');
    expect(res.role).toBe('owner');

    // Second call idempotent, stays owner
    const res2 = await ensureBootstrapWithOwner(fixture.conn, 'owner1');
    expect(res2.role).toBe('owner');

    // Another user not owner yet
    seedUser('member1');
    const { addMember: add } = await import('./repository');
    await add(fixture.conn, { workspaceId: 'default', userId: 'member1', role: 'member' });
    const membership = await resolveMembership(fixture.conn, 'member1');
    expect(membership?.role).toBe('member');
  });

  it('acceptInviteByToken creates membership and marks invite accepted', async () => {
    await ensureBootstrapWorkspace(fixture.conn);
    seedUser('inviter');
    seedUser('invitee');
    await addMember(fixture.conn, { workspaceId: 'default', userId: 'inviter', role: 'admin' });

    const secret = 'test-secret-1234567890-1234567890-123';
    const { rawToken } = await createInvite(fixture.conn, {
      workspaceId: 'default',
      role: 'member',
      createdBy: 'inviter',
      secret,
    });

    const result = await acceptInviteByToken(fixture.conn, rawToken, 'invitee', secret);
    expect(result.workspaceId).toBe('default');
    expect(result.role).toBe('member');

    const member = await getMember(fixture.conn, 'default', 'invitee');
    expect(member).not.toBeNull();

    // Replay should fail (already accepted)
    await expect(acceptInviteByToken(fixture.conn, rawToken, 'invitee', secret)).rejects.toThrow(WorkspaceError);
  });

  it('acceptInviteByToken rejects revoked and expired invites', async () => {
    await ensureBootstrapWorkspace(fixture.conn);
    seedUser('u1');
    seedUser('u2');
    await addMember(fixture.conn, { workspaceId: 'default', userId: 'u1', role: 'owner' });

    const secret = 'test-secret-1234567890-1234567890-123';
    const { invite, rawToken } = await createInvite(fixture.conn, {
      workspaceId: 'default',
      secret,
      expiresInDays: 1,
    });

    // Revoke
    const { revokeInvite } = await import('./repository');
    await revokeInvite(fixture.conn, invite.id);

    await expect(acceptInviteByToken(fixture.conn, rawToken, 'u2', secret)).rejects.toThrow(WorkspaceError);

    // Expired token (create with past date via direct token)
    const { createInviteToken } = await import('./tokens');
    const past = new Date(Date.now() - 1000);
    const expiredToken = createInviteToken('fake-id', past, secret);
    await expect(acceptInviteByToken(fixture.conn, expiredToken, 'u2', secret)).rejects.toThrow(WorkspaceError);
  });
});
