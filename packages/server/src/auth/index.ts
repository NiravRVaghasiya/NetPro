// packages/server/src/auth/index.ts
//
// Phase 1 scaffold: authentication is a server concern, not a Next.js one.
// Full local-identity / optional remote auth lands in Phase 5. For now the
// package exposes a no-op local trust mode so routes can be wired without
// pulling next-auth or GitHub OAuth into the server process.

export type AuthMode = 'local-open' | 'disabled';

export type AuthContext = {
  mode: AuthMode;
  /**
   * When true, the caller is treated as a trusted local operator.
   * Phase 5 will refine this (loopback binding, installation identity, …).
   */
  trustedLocal: boolean;
};

/**
 * Resolve auth context for a request.
 *
 * Phase 1: always `local-open` with `trustedLocal: true`. This does **not**
 * implement security for remote exposure — default bind is 127.0.0.1, and
 * Phase 5 / Phase 23 will gate remote access behind real auth.
 */
export function resolveAuthContext(_opts?: {
  remoteAddress?: string | null;
}): AuthContext {
  return {
    mode: 'local-open',
    trustedLocal: true,
  };
}
