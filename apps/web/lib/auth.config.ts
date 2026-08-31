// apps/web/lib/auth.config.ts
//
// EDGE-SAFE: this file is consumed by middleware.ts, which Next.js compiles
// for the Edge Runtime. Do NOT import ./db, ./auth, @netpro/db, or
// @auth/drizzle-adapter here (or anything that transitively imports them) —
// any of those pull in better-sqlite3, a native addon the Edge Runtime can't
// bundle, and the build will fail with a "Module not found" error tracing
// through "Edge Middleware". See docs/superpowers/plans/2026-08-30-v0.1-alpha-scaffold.md,
// Task 10 Step 6.
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.userId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.userId as string;
      return session;
    },
  },
  providers: [], // real providers are registered only in auth.ts (Node runtime)
} satisfies NextAuthConfig;
