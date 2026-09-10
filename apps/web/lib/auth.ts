/* eslint-disable @typescript-eslint/no-explicit-any */
// apps/web/lib/auth.ts
// v3.0 Phase 1 — multi-user auth with workspaces.
// Phase 5 (local-first) — GitHub OAuth is one mode among three, not a
// prerequisite. `auth()` is now a thin dispatcher:
//
//   • github  → the Auth.js session (unchanged v3.0 behaviour)
//   • local   → the installation owner when the request comes straight from
//               this machine; otherwise the Auth.js session (which is null
//               unless GitHub is configured as a fallback)
//   • open    → the installation owner, for callers behind their own auth
//
// The edge-safe auth.config.ts still describes the JWT; this Node-runtime
// layer enforces membership / break-glass owner logic against the database.

import { headers } from 'next/headers';
import NextAuth from 'next-auth';
import type { Session } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { authConfig } from './auth.config';
import {
  isGitHubConfigured,
  isTrustedLocalRequest,
  resolveWebAuthMode,
  trustLocalUi,
} from './auth-mode';
import { conn } from './db';
import { ensureLocalOwnerSession } from './local-owner';
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

/**
 * Session cookies are only ever minted by Auth.js, and Auth.js only runs in
 * `github` mode. In the other modes a deterministic placeholder keeps
 * `MissingSecret` from turning a credential-free local start into a crash.
 * (There is nothing to protect: no OAuth session exists in those modes.)
 */
const LOCAL_SESSION_SECRET =
  'netpro-local-mode-has-no-oauth-sessions-and-needs-no-secret';

const nextAuth = NextAuth({
  ...authConfig,
  adapter,
  secret:
    process.env.NEXTAUTH_SECRET ??
    process.env.AUTH_SECRET ??
    LOCAL_SESSION_SECRET,
  providers: isGitHubConfigured()
    ? [
        GitHub({
          clientId: process.env.GITHUB_CLIENT_ID!,
          clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        }),
      ]
    : [],
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

export const { handlers, signIn, signOut } = nextAuth;

/**
 * Who is calling?
 *
 * Phase 5: every caller in the web app goes through here (directly or via
 * `requireScope()`), so the local-first decision lives in exactly one place.
 */
export async function auth(): Promise<Session | null> {
  const mode = resolveWebAuthMode();

  // Read the request context on every call, in every mode. Auth.js used to do
  // this internally, and Next uses the DynamicServerError it raises during
  // `next build` to keep pages that ask "who is calling?" out of the static
  // export. Swallowing it (as a `try/catch` here would) bakes the private
  // workspace into the build output — so it is deliberately not caught.
  const requestHeaders = await headers();

  if (mode !== 'github') {
    if (
      mode === 'open' ||
      isTrustedLocalRequest(requestHeaders, { trustLocalUi: trustLocalUi() })
    ) {
      return (await ensureLocalOwnerSession()) as unknown as Session;
    }
    // local mode, remote caller: fall through to an OAuth session if one
    // exists, otherwise deny. Without GitHub credentials there is nothing that
    // could authenticate anyone — and asking Auth.js anyway would log a
    // spurious UntrustedHost error on every remote request.
    if (!isGitHubConfigured()) return null;
  }

  if (!isGitHubConfigured()) return null;

  return await nextAuth.auth();
}
