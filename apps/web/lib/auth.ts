/* eslint-disable @typescript-eslint/no-explicit-any */
// apps/web/lib/auth.ts
// v3.0 Phase 5 — authentication without GitHub OAuth required for local use.
// The edge-safe auth.config.ts allows any GitHub account to get a JWT;
// this Node-runtime layer enforces membership and break-glass owner logic
// against the database. GitHub OAuth is optional: when no credentials are
// provided the UI operates in local-auth mode (owner sign-in via config,
// no provider flow).
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
// `<SqlFlavor extends SqlFlavorOptions>(db: SqlFlavor, schema?: DefaultSchema<SqlFlavor>)`.
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

// Build providers array conditionally: include GitHub only when credentials are set.
const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const providers = githubClientId && githubClientSecret
  ? [new GitHub({ clientId: githubClientId, clientSecret: githubClientSecret })]
  : [] as any;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter,
  providers,
  callbacks: {
    ...authConfig.callbacks,