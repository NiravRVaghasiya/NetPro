// v2.5 Phase 1 — privacy hashing for profile views.
//
// `profile_views.viewer_ip` and `profile_views.viewer_fingerprint` never hold
// raw identifiers. Both are HMAC-SHA256 digests computed over the viewer's
// request attributes under a **daily salt**, truncated to 16 hex chars:
//
//   hash = HMAC-SHA256(key = dailySalt, message = ip + "\n" + UA [+ accept-language])
//
// where `dailySalt = SHA-256(baseSalt + "\n" + UTC day)`. Properties that
// Phase 2's beacon and Phase 3's analytics rely on:
//
//   * **Deterministic within a day** — the same (ip, UA, day) hashes to the
//     same value, so 24h de-duplication and the same-IP owner heuristic work
//     without storing anything reversible.
//   * **Rotates every UTC day** — a hash from Monday cannot be correlated
//     with a hash from Tuesday, so there is no cross-day fingerprint even if
//     the base salt leaks.
//   * **Keyed** — without the operator's `NETPRO_VIEW_SALT` an attacker
//     cannot precompute the hash for an IP, and a breached database yields
//     values that are useless off-line.
//   * **UA-bound** — two people behind one NAT with different browsers get
//     different hashes, so "same hash" means "same person-ish", not "same
//     house".
//
// 16 hex chars (64 bits) is a deliberate, documented trade-off (plan §Risks):
// collisions are conceivable at very large volumes but harmless for counting
// and de-duplication, and the short form keeps every stored id compact.
import { createHash, createHmac } from 'node:crypto';

/** Length of every stored viewer hash, in hex characters (64 bits). */
export const VIEWER_HASH_HEX_LENGTH = 16;

/** UTC `YYYY-MM-DD` for the given instant — the salt rotation unit. */
export function utcDayIso(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The salt for one UTC day: derived from the operator secret so the secret
 * itself is never compared or stored next to the hashes, and unique per day
 * so digests cannot be correlated across days.
 */
export function dailyViewSalt(baseSalt: string, date: Date = new Date()): string {
  return createHash('sha256')
    .update(`${baseSalt}\n${utcDayIso(date)}`, 'utf8')
    .digest('hex');
}

/** Full HMAC-SHA256 hex digest (never truncated — callers slice). */
export function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export interface ViewerRequestAttributes {
  ip: string;
  userAgent: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}

/**
 * The value stored in `profile_views.viewer_ip`: a 16-hex HMAC of
 * `ip + UA` under the daily salt. `userAgent` is part of the message so a
 * shared IP with different browsers does not collapse into one "viewer".
 */
export function hashViewerIp(
  input: ViewerRequestAttributes & { baseSalt: string; date?: Date },
): string {
  const salt = dailyViewSalt(input.baseSalt, input.date ?? new Date());
  return hmacSha256Hex(salt, `${input.ip}\n${input.userAgent ?? ''}`).slice(
    0,
    VIEWER_HASH_HEX_LENGTH,
  );
}

/**
 * The value stored in `profile_views.viewer_fingerprint`: a 16-hex HMAC of
 * `ip + UA + accept-language` under the daily salt. Used only to de-duplicate
 * rapid reloads within 24h — deliberately a *different* digest than
 * `viewer_ip` (accept-language is mixed in) and, like every hash here,
 * unusable across days.
 */
export function hashViewerFingerprint(
  input: ViewerRequestAttributes & { baseSalt: string; date?: Date },
): string {
  const salt = dailyViewSalt(input.baseSalt, input.date ?? new Date());
  return hmacSha256Hex(salt, `${input.ip}\n${input.userAgent ?? ''}\n${input.acceptLanguage ?? ''}`).slice(
    0,
    VIEWER_HASH_HEX_LENGTH,
  );
}

/** True when the value looks like a stored viewer hash (16 lowercase hex). */
export function isViewerHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}
