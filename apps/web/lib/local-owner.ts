// apps/web/lib/local-owner.ts
// Phase 5 — the local installation identity, expressed as a session.
//
// In `local` (or `open`) mode there is no OAuth round-trip to give the app a
// user id, so this module supplies one: it reads (creating once, if needed)
// the installation identity in `~/.netpro/config.toml`, mirrors it into a
// deterministic row in the `users` table, ensures that user owns the bootstrap
// workspace, and returns an Auth.js-shaped session.
//
// The `users` row exists because the rest of the app — workspace membership,
// activity logs, retention, every `requireScope()` — is keyed by user id. The
// row is a *projection* of the installation identity, not a second identity:
// its id is derived (`local:<installation id>`) so it can be recreated at any
// time and can never collide with an OAuth account's id.
//
// Node runtime only: imports @netpro/db, ./db, and ./workspaces.

import { ensureInstallationIdentity, type InstallationIdentity } from "@netpro/db";
import { ensureLocalOwnerUser, ensureOwnerMembership } from "./workspaces";

/** Deterministic user id for the local operator. */
export function localOwnerUserId(installationId: string): string {
  return `local:${installationId}`;
}

export const LOCAL_OWNER_FALLBACK_ID = "local:installation-unavailable";

export type LocalOwner = {
  userId: string;
  installationId: string;
  name: string;
  email: string;
  /** False when `~/.netpro` could not be written (read-only home); the app still runs. */
  persisted: boolean;
};

const FALLBACK_NAME = "Local owner";
const FALLBACK_EMAIL = "local@netpro.local";

function displayName(identity: InstallationIdentity): string {
  return identity.owner?.trim() || FALLBACK_NAME;
}

function displayEmail(identity: InstallationIdentity): string {
  return identity.email?.trim() || FALLBACK_EMAIL;
}

/**
 * Read the installation identity, minting it on first use.
 *
 * Deliberately tolerant: a container with a read-only home directory should
 * still serve its operator a working local UI. The failure is logged (and the
 * caller is told `persisted: false`) rather than thrown, and the identity used
 * is stable (`local:installation-unavailable`) so the same operator always
 * maps to the same rows.
 */
export function resolveInstallationIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { identity: InstallationIdentity; persisted: boolean } {
  try {
    return { identity: ensureInstallationIdentity(env).identity, persisted: true };
  } catch (error) {
    console.warn(
      "[netpro/auth] could not read or create the local installation identity in ~/.netpro; " +
        "continuing with an in-memory local owner. Set NETPRO_HOME to a writable directory to persist it.",
      error,
    );
    return {
      identity: {
        id: "installation-unavailable",
        createdAt: new Date(0).toISOString(),
      },
      persisted: false,
    };
  }
}

/** Resolve (and persist) the local operator, including bootstrap ownership. */
export async function resolveLocalOwner(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalOwner> {
  const { identity, persisted } = resolveInstallationIdentity(env);
  const userId = persisted
    ? localOwnerUserId(identity.id)
    : LOCAL_OWNER_FALLBACK_ID;
  const name = displayName(identity);
  const email = displayEmail(identity);

  await ensureLocalOwnerUser(userId, name, email);
  await ensureOwnerMembership(userId);

  return { userId, installationId: identity.id, name, email, persisted };
}

/** An Auth.js-shaped session for the local operator. */
export type LocalSession = {
  user: { id: string; name: string; email: string };
  expires: string;
};

let cachedSession: Promise<LocalSession> | null = null;

/** Forget the cached session (tests, and after a re-init in-process). */
export function resetLocalOwnerSessionCache(): void {
  cachedSession = null;
}

export async function ensureLocalOwnerSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSession> {
  // One installation per process: resolving it on every request would mean a
  // membership lookup on every page view. The promise is cached (not just the
  // value) so concurrent first requests cannot race their own inserts.
  cachedSession ??= buildLocalOwnerSession(env);
  return cachedSession;
}

async function buildLocalOwnerSession(env: NodeJS.ProcessEnv): Promise<LocalSession> {
  const owner = await resolveLocalOwner(env);
  return {
    user: { id: owner.userId, name: owner.name, email: owner.email },
    // Never expires: there is no token to rotate, and the operator *is* the
    // process owner. Auth.js only validates this on JWT sessions, which this
    // object never becomes.
    expires: new Date(8_640_000_000_000_000).toISOString(),
  };
}
