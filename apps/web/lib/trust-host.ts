// Phase 6 — reconcile NEXTAUTH_URL with Auth.js v5's host-trust rule.
//
// THE BUG THIS FIXES, observed on a real production build:
//
//   [auth][error] UntrustedHost: Host must be trusted.
//   URL was: http://localhost:3000/api/auth/session
//
// ...and every authenticated request 401s while /api/auth/providers returns
// "There was a problem with the server configuration."
//
// Auth.js v5 derives `trustHost` from the environment like this
// (@auth/core/lib/utils/env.js):
//
//   config.trustHost ??= !!(AUTH_URL ?? AUTH_TRUST_HOST ?? CF_PAGES
//                           ?? NODE_ENV !== "production")
//
// Note what is absent: **NEXTAUTH_URL**. next-auth reads NEXTAUTH_URL for the
// base path and the callback origin, so the variable looks fully supported —
// but it does not make the host trusted. In development the NODE_ENV clause
// masks the problem entirely, so this only breaks in production.
//
// NetPro's own docs, .env.example, and docker-compose.yml all told operators
// to set NEXTAUTH_URL, which means a self-hosted deploy following the
// documentation would have had authentication fail outright. Vercel is
// unaffected (the VERCEL clause), which is exactly why a Vercel-only test
// would have missed it.
//
// Rather than push another environment variable onto operators, treat an
// explicitly configured application URL as an explicit statement of trust:
// the operator naming their own origin *is* the security decision that
// AUTH_TRUST_HOST asks for. If neither is set we return undefined and leave
// Auth.js's own default in place, so we never widen trust beyond what the
// operator configured.

/**
 * Resolve `trustHost` for the Auth.js config.
 *
 * @returns `true` when the operator has declared the app's origin or opted in,
 *          `false` when they explicitly opted out, `undefined` to defer to
 *          Auth.js's built-in default.
 */
export function resolveTrustHost(
  env: NodeJS.ProcessEnv = process.env
): boolean | undefined {
  const optOut = env.AUTH_TRUST_HOST?.trim().toLowerCase();
  if (optOut && /^(0|false|no|off)$/.test(optOut)) return false;
  if (optOut) return true;

  // AUTH_URL is already honoured by Auth.js; NEXTAUTH_URL is the v4-compatible
  // spelling NetPro documents, and is the one that silently did not work.
  if (env.AUTH_URL?.trim() || env.NEXTAUTH_URL?.trim()) return true;

  return undefined;
}
