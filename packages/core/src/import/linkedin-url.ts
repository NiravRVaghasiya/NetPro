// packages/core/src/import/linkedin-url.ts
//
// Single-profile LinkedIn URL identity: validation + normalization shared by
// every surface that accepts "paste a LinkedIn profile URL" (the Web UI's
// Add Person flow, POST /api/contacts, and any future CLI importer).
//
// This module is deliberately syntactic only — it never touches the network.
// URL validation ("is this a LinkedIn profile URL?") stays separate from
// profile retrieval/import ("who is this?"), which NetPro does not perform
// against LinkedIn (there is no LinkedIn scraping in this project).
//
// Canonical form:
//
//   https://www.linkedin.com/in/<username>
//
//   * scheme: http(s) accepted, always normalized to https; a missing scheme
//     (`linkedin.com/in/jane`) is assumed https, like browsers do;
//   * host: `linkedin.com` or any `*.linkedin.com` subdomain (e.g. `www`),
//     always normalized to `www.linkedin.com`. Lookalikes such as
//     `linkedin.com.evil.com` or `fakelinkedin.com` are rejected;
//   * path: `/in/<username>` with an optional trailing slash. LinkedIn
//     profile sub-pages (`/in/jane/recent-activity/…`) collapse to the base
//     profile — they identify the same person;
//   * query strings and fragments (`?trk=…`, `#…`) are stripped: they
//     identify the click, not the profile.
//
// Everything else on linkedin.com (`/company/…`, `/jobs/…`, `/school/…`,
// `/posts/…`, `/in` without a username, …) is an *unsupported route*, and
// anything off linkedin.com is *not a LinkedIn URL*. The distinction drives
// the human-readable errors the UI shows.

export type LinkedInUrlErrorCode =
  | "empty"
  | "invalid_url"
  | "not_linkedin"
  | "unsupported_route";

export class LinkedInUrlError extends Error {
  readonly code: LinkedInUrlErrorCode;
  constructor(code: LinkedInUrlErrorCode, message: string) {
    super(message);
    this.name = "LinkedInUrlError";
    this.code = code;
  }
}

export interface LinkedInProfileRef {
  /** The profile slug exactly as given (`john-doe`). */
  username: string;
  /** Lower-cased slug — the stable dedupe key. */
  usernameKey: string;
  /** Canonical `https://www.linkedin.com/in/<username>` (no trailing slash). */
  normalizedUrl: string;
}

/** Hard cap: a pasted URL longer than this is not a profile link. */
export const LINKEDIN_URL_MAX_CHARS = 2048;

/** Slugs are 1–128 chars of letters, digits, `.`, `_`, `-`. */
const USERNAME_RE = /^(?!.*\.\.)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
// Control characters must never survive in a pasted URL.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE_RE = /[\s\u0000-\u001f\u007f-\u009f]/;

export const LINKEDIN_PROFILE_EXAMPLE = "https://www.linkedin.com/in/username";

export function invalidLinkedInUrlMessage(): string {
  return (
    "That doesn't look like a LinkedIn profile URL. " +
    `Please paste a URL like: ${LINKEDIN_PROFILE_EXAMPLE}`
  );
}

export function unsupportedLinkedInUrlMessage(): string {
  return (
    "This LinkedIn URL isn't a supported profile URL. " +
    `Please use an individual profile URL like: ${LINKEDIN_PROFILE_EXAMPLE}`
  );
}

function fail(code: LinkedInUrlErrorCode, message: string): never {
  throw new LinkedInUrlError(code, message);
}

/**
 * Parse + normalize a LinkedIn profile URL. Throws `LinkedInUrlError` with a
 * human-readable message (safe to show in the UI / API response as-is).
 */
export function parseLinkedInProfileUrl(raw: string): LinkedInProfileRef {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    fail("empty", "Paste a LinkedIn profile URL to continue.");
  }
  if (trimmed.length > LINKEDIN_URL_MAX_CHARS || CONTROL_OR_SPACE_RE.test(trimmed)) {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }

  // Scheme-less input (`linkedin.com/in/jane`) is assumed https — the same
  // forgiveness browsers apply. Anything with an explicit non-http(s)
  // scheme (`javascript:…`, `mailto:…`, `ftp:…`) is rejected, not guessed.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }
  // Credentials, non-default ports, and exotic hosts are never profile links.
  if (parsed.username !== "" || parsed.password !== "") {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }
  if (
    parsed.port !== "" &&
    !((parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443"))
  ) {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  // Single-label hosts (`not-a-url` → `https://not-a-url/`) are not URLs
  // anyone meant to paste — they read as malformed, not as a wrong domain.
  if (!host.includes(".")) {
    fail("invalid_url", invalidLinkedInUrlMessage());
  }
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
    fail("not_linkedin", invalidLinkedInUrlMessage());
  }

  // `/in/<username>` (+ optional trailing slash / profile sub-pages, which
  // collapse to the base profile). The `in` segment matches case-insensitively
  // and normalizes to lowercase; the username keeps its given case.
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2 || segments[0]!.toLowerCase() !== "in") {
    fail("unsupported_route", unsupportedLinkedInUrlMessage());
  }
  let username: string;
  try {
    username = decodeURIComponent(segments[1]!);
  } catch {
    fail("unsupported_route", unsupportedLinkedInUrlMessage());
  }
  if (!USERNAME_RE.test(username)) {
    fail("unsupported_route", unsupportedLinkedInUrlMessage());
  }

  return {
    username,
    usernameKey: username.toLowerCase(),
    normalizedUrl: `https://www.linkedin.com/in/${username}`,
  };
}

export type LinkedInParseResult =
  | { ok: true; ref: LinkedInProfileRef }
  | { ok: false; code: LinkedInUrlErrorCode; message: string };

/** Non-throwing variant for callers that branch on the outcome. */
export function tryParseLinkedInProfileUrl(raw: string): LinkedInParseResult {
  try {
    return { ok: true, ref: parseLinkedInProfileUrl(raw) };
  } catch (error) {
    if (error instanceof LinkedInUrlError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Two LinkedIn URLs identify the same profile when both parse and their
 * slugs match case-insensitively. Unparseable inputs never match — a stored
 * `linkedin.com/in/jane` still matches a pasted
 * `https://www.linkedin.com/in/Jane/?trk=…`, but a stored company URL never
 * matches anything.
 */
export function sameLinkedInProfile(a: string, b: string): boolean {
  const left = tryParseLinkedInProfileUrl(a);
  const right = tryParseLinkedInProfileUrl(b);
  if (!left.ok || !right.ok) return false;
  return left.ref.usernameKey === right.ref.usernameKey;
}

/**
 * Turn a profile slug into a placeholder display name (`john-doe` → "John
 * Doe") for contacts created from a bare URL. A trailing numeric/hash token
 * (`jane-doe-4b5a6c`, `john-smith-123456`) is dropped — it is LinkedIn's
 * disambiguator, not part of the name.
 */
export function linkedinSlugToName(username: string): string {
  const parts = username.split(/[-_.]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return username;
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && (/^\d+$/.test(last) || /^[0-9a-fA-F]{4,}$/.test(last))) {
    parts.pop();
  }
  const words = parts.map((p) =>
    p.length <= 2 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
  );
  return words.join(" ") || username;
}
