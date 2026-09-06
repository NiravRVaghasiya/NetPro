// apps/web/lib/auth.config.ts
//
// EDGE-SAFE: this file is consumed by proxy.ts (renamed from middleware.ts in
// Phase 6 for the Next.js 16 convention), the request boundary. Do NOT import ./db, ./auth, @netpro/db, or
// @auth/drizzle-adapter here (or anything that transitively imports them) —
// any of those pull in better-sqlite3, a native addon the Edge Runtime can't
// bundle, and the build will fail with a "Module not found" error tracing
// through "Edge Middleware". See docs/superpowers/plans/2026-08-30-v0.1-alpha-scaffold.md,
// Task 10 Step 6.
import type { NextAuthConfig } from "next-auth";
import { isOwnerGitHubId } from "./owner";
import { resolveTrustHost } from "./trust-host";

const trustHost = resolveTrustHost();

export const authConfig = {
  // Auth.js v5 does NOT infer host trust from NEXTAUTH_URL — only from
  // AUTH_URL/AUTH_TRUST_HOST/VERCEL/CF_PAGES/non-production NODE_ENV. Without
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
      return (
        account?.provider === "github" &&
        isOwnerGitHubId(account.providerAccountId)
      );
    },
    async jwt({ token, user, account }) {
      if (account) {
        if (account.provider !== "github") return null;
        token.githubId = account.providerAccountId;
      }
      if (user?.id) token.userId = user.id;
      // Re-check every read, not only sign-in: configuration changes revoke
      // old owners, and pre-upgrade JWTs cannot bypass the single-owner gate.
      // Never accept identity fields from the client-controlled session update.
      if (
        !isOwnerGitHubId(token.githubId) ||
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
