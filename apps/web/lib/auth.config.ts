// apps/web/lib/auth.config.ts
//
// EDGE-SAFE: this file is consumed by proxy.ts (renamed from middleware.ts in
// Phase 6 for the Next.js 16 convention), the request boundary. Do NOT import ./db, ./auth, @netpro/db, or
// @auth/drizzle-adapter here (or anything that transitively imports them) —
// any of those pull in better-sqlite3, a native addon the Edge Runtime can't
// bundle, and the build will fail with a "Module not found" error tracing
// through "Edge Middleware".
//
// v3.0 Phase 1: auth is now multi-user via workspaces. The edge-safe config
// allows any GitHub account to get a JWT; the Node-runtime `auth.ts` layer
// enforces membership / break-glass owner checks against the database.
// The proxy only checks that a session exists; deeper role floors happen
// in server components via `requireScope()`.
import type { NextAuthConfig } from "next-auth";
import { resolveTrustHost } from "./trust-host";

const trustHost = resolveTrustHost();

export const authConfig = {
  // Auth.js v5 does NOT infer host trust from NEXTAUTH_URL — only from
  // AUTH_URL/AUTH_TRUST_HOST/CF_PAGES/non-production NODE_ENV. Without
  // this, a self-hosted production deploy configured exactly as NetPro's docs
  // describe fails every request with UntrustedHost. See ./trust-host.ts.
  ...(trustHost === undefined ? {} : { trustHost }),
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async signIn({ account }) {
      // Edge-safe: allow any GitHub account to obtain a session; membership
      // is enforced in the Node-runtime auth.ts callback which can access DB.
      return account?.provider === "github";
    },
    async jwt({ token, user, account }) {
      if (account) {
        if (account.provider !== "github") return null;
        token.githubId = account.providerAccountId;
      }
      if (user?.id) token.userId = user.id;
      // Minimal edge-safe validation: require githubId + userId.
      // Break-glass owner and workspace membership are verified in Node
      // runtime (auth.ts) where DB is available.
      if (
        typeof token.githubId !== "string" ||
        !token.githubId ||
        typeof token.userId !== "string" ||
        !token.userId
      )
        return null;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.userId as string;
      return session;
    },
  },
  providers: [], // real providers are registered only in auth.ts (Node runtime)
} satisfies NextAuthConfig;
