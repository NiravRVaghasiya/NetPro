import { Command } from 'commander';
import { createDb } from '@netpro/db';
import {
  ensureBootstrapWorkspace,
  getWorkspaceMembers,
  listInvites,
  createInvite,
  revokeInvite,
  addMember,
  removeMember,
  updateMemberRole,
  listWorkspaces,
} from '@netpro/core/src/workspaces';

function getConn() {
  return createDb();
}

export function registerTeamCommand(program: Command): void {
  const team = program.command('team').description('Manage workspace members and invites (v3.0 Phase 1)');

  team
    .command('list')
    .description('List workspaces and members')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const conn = getConn();
      const workspaces = await listWorkspaces(conn);
      const wsId = 'default';
      const members = await getWorkspaceMembers(conn, wsId);
      const invites = await listInvites(conn, wsId);
      if (opts.json) {
        console.log(JSON.stringify({ workspaces, members, invites }, null, 2));
      } else {
        console.log(`Workspaces: ${workspaces.length}`);
        for (const ws of workspaces) {
          console.log(`- ${ws.id} (${ws.slug}): ${ws.name}`);
        }
        console.log(`\nMembers in ${wsId}: ${members.length}`);
        for (const m of members) {
          console.log(`- ${m.userId} : ${m.role} (since ${m.createdAt})`);
        }
        console.log(`\nInvites in ${wsId}: ${invites.length}`);
        for (const inv of invites) {
          const status = inv.revokedAt ? 'revoked' : inv.acceptedAt ? 'accepted' : 'pending';
          console.log(`- ${inv.id} : ${inv.role} ${status} expires ${inv.expiresAt}`);
        }
      }
    });

  team
    .command('invite')
    .description('Create an invite link')
    .option('--role <role>', 'Role: owner|admin|member|viewer', 'member')
    .option('--expires <days>', 'Expires in days (1-30)', '7')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const conn = getConn();
      await ensureBootstrapWorkspace(conn);
      const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'dev-secret-please-set-NEXTAUTH_SECRET';
      const expiresInDays = Number(opts.expires);
      const { invite, rawToken } = await createInvite(conn, {
        workspaceId: 'default',
        role: opts.role,
        expiresInDays: Number.isFinite(expiresInDays) ? expiresInDays : 7,
        secret,
      });
      const url = `/invite/${rawToken}`;
      if (opts.json) {
        console.log(JSON.stringify({ invite, token: rawToken, url }, null, 2));
      } else {
        console.log(`Invite created: ${invite.id}`);
        console.log(`Role: ${invite.role}`);
        console.log(`Expires: ${invite.expiresAt}`);
        console.log(`Token: ${rawToken}`);
        console.log(`URL: ${url}`);
        console.log(`\nShare the URL securely. It is HMAC-signed and single-use.`);
      }
    });

  team
    .command('revoke')
    .description('Revoke an invite')
    .argument('<inviteId>', 'Invite ID')
    .action(async (inviteId) => {
      const conn = getConn();
      await revokeInvite(conn, inviteId);
      console.log(`Invite ${inviteId} revoked.`);
    });

  team
    .command('add')
    .description('Add a user as member directly (admin tool)')
    .argument('<userId>', 'User ID (from user table)')
    .option('--role <role>', 'Role', 'member')
    .action(async (userId, opts) => {
      const conn = getConn();
      await ensureBootstrapWorkspace(conn);
      const member = await addMember(conn, { workspaceId: 'default', userId, role: opts.role });
      console.log(`Added ${userId} as ${member.role}`);
    });

  team
    .command('rm')
    .description('Remove a member')
    .argument('<userId>', 'User ID')
    .action(async (userId) => {
      const conn = getConn();
      await removeMember(conn, 'default', userId);
      console.log(`Removed ${userId}`);
    });

  team
    .command('role')
    .description('Change member role')
    .argument('<userId>', 'User ID')
    .argument('<role>', 'New role')
    .action(async (userId, role) => {
      const conn = getConn();
      const member = await updateMemberRole(conn, 'default', userId, role);
      console.log(`Updated ${userId} to ${member.role}`);
    });
}
