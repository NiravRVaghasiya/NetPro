// apps/web/lib/auth.ts
// v3.0 Phase 1 — multi-user auth with workspaces.
// The edge-safe auth.config.ts allows any GitHub account to get a JWT;
// this Node-runtime layer enforces membership and break-glass owner logic
// against the database.

import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { authConfig } from './auth.config';
import { conn } from './db';
import { isOwnerGitHubId } from './owner';
import {
  ensureBootstrapWorkspaceExists,
  getMembershipForUser,
  ensureOwnerMembership,
  hasAnyMembers,
} from './workspaces';

// `conn` is the discriminated union `SqliteConn | PgConn` from packages/db's
// createDb(). `DrizzleAdapter` is a single generic function,
// `<SqlFlavor extends SqlFlavorOptions>(db: SqlFlavor, schema?: DefaultSchema<SqlFlavor>)`
// — not dialect-specific overloads. Calling it directly with `conn.db` (a union of
// BetterSQLite3Database | NodePgDatabase) and `conn.schema.*` (whose individual table
// properties distribute to SQLiteTable | PgTable per-field, not as two whole matching
// objects) leaves TypeScript unable to match the passed schema against
// `DefaultSchema<SqlFlavor>` for either branch, so the call fails to typecheck.
// Narrowing on `conn.dialect` first collapses `conn.db`/`conn.schema` to one concrete
// dialect per branch, letting the generic resolve cleanly. Both branches are
// behaviorally identical; only the static types differ.
const adapter =
  conn.dialect === 'sqlite'
    ? DrizzleAdapter(conn.db, {
        usersTable: conn.schema.users,
        accountsTable: conn.schema.accounts,
        sessionsTable: conn.schema.sessions,
        verificationTokensTable: conn.schema.verificationTokens,
      })
    : DrizzleAdapter(conn.db, {
        usersTable: conn.schema.users,
        accountsTable: conn.schema.accounts,
        sessionsTable: conn.schema.sessions,
        verificationTokensTable: conn.schema.verificationTokens,
      });

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter,
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      if (account?.provider !== 'github') return false;
      const githubId = account.providerAccountId;
      if (!githubId) return false;

      try {
        await ensureBootstrapWorkspaceExists();

        // Break-glass owner always allowed — and ensured as owner member.
        if (isOwnerGitHubId(githubId)) {
          if (user?.id) {
            await ensureOwnerMembership(user.id);
          }
          return true;
        }

        // If no members exist yet, only break-glass owner can sign in (single-owner compatibility).
        // This prevents open registration on a fresh install.
        const anyMembers = await hasAnyMembers();
        if (!anyMembers) {
          return false;
        }

        // Existing member?
        if (user?.id) {
          const membership = await getMembershipForUser(user.id);
          if (membership) return true;
        }

        // No membership — deny. Invite acceptance happens via /invite/[token] page
        // which creates membership before the next sign-in attempt, or the user
        // can be added by an admin via API.
        return false;
      } catch (error) {
        console.error('[netpro/auth] signIn check failed:', error);
        // Fail closed: deny sign-in on error, but allow break-glass owner as fallback.
        return isOwnerGitHubId(githubId);
      }
    },
    async jwt({ token, user, account }) {
      // Run edge-safe checks first (githubId + userId)
      const base = await (authConfig.callbacks as any).jwt({ token, user, account });
      if (!base) return null;

      try {
        // Break-glass owner bypasses membership check
        if (isOwnerGitHubId(base.githubId)) {
          if (base.userId) {
            // Ensure owner membership exists (idempotent)
            await ensureBootstrapWorkspaceExists();
            await ensureOwnerMembership(base.userId as string);
          }
          return base;
        }

        // Check live membership — revoked members get null token (session invalidated)
        const membership = await getMembershipForUser(base.userId as string);
        if (!membership) return null;

        // Attach workspace context to token for downstream use
        (base as any).workspaceId = membership.workspaceId;
        (base as any).workspaceRole = membership.role;
        return base;
      } catch (error) {
        console.error('[netpro/auth] jwt membership check failed:', error);
        // On DB error, fail closed unless break-glass
        return isOwnerGitHubId((base as any).githubId) ? base : null;
      }
    },
    async session({ session, token }) {
      const base = await (authConfig.callbacks as any).session({ session, token });
      // Expose workspace info to server components if available
      if (base.user) {
        (base.user as any).workspaceId = (token as any).workspaceId ?? 'default';
        (base.user as any).workspaceRole = (token as any).workspaceRole ?? 'owner';
      }
      return base;
    },
  },
});
