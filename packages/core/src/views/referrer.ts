// v2.5 Phase 2 — referrer sanitization for the profile-view beacon.
//
// `profile_views.referrer` must never hold a full URL: query strings carry
// tokens (OAuth callbacks, share links, signed `?v=` contact-resolution
// tokens) and we have no business storing them. The stored value is the
// referrer reduced to `scheme://host/path` — no query, no hash, no
// credentials — capped at 200 chars. Anything that is not a plain
// http(s) URL (relative URLs, `javascript:`/`data:`/`file:` schemes,
// unparseable garbage) is dropped to `null` rather than stored.
//
// Note the split with `parseUtm`: attribution is read from the *raw*
// referrer URL (before this strips its query), because the query string is
// exactly where the `utm_*` parameters live.
import { URL } from 'node:url';

/** Cap for the stored `origin + path` value, per the Phase 2 plan. */
export const REFERRER_MAX_LENGTH = 200;

/**
 * Reduce a raw `Referer` header / beacon `r` param to a storable value:
 * `scheme://host/path`, query + hash stripped, credentials rejected, capped
 * at 200 chars. Returns `null` for missing or un-storable input.
 */
export function parseReferrer(
  referrer: string | null | undefined,
): string | null {
  if (typeof referrer !== 'string') return null;
  const trimmed = referrer.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null; // relative URLs, whitespace-laden garbage, etc.
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentials in a referrer are a leak, not data — drop the whole value.
  if (url.username !== '' || url.password !== '') return null;
  let value = `${url.protocol}//${url.host}${url.pathname}`;
  if (value.length > REFERRER_MAX_LENGTH) {
    value = value.slice(0, REFERRER_MAX_LENGTH);
  }
  return value;
}
