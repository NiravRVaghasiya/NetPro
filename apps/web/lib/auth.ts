// apps/web/lib/auth.ts
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { authConfig } from './auth.config';
import { conn } from './db';

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
});
