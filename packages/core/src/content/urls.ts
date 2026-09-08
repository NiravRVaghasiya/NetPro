// packages/core/src/content/urls.ts
//
// URL identity for the content tracker. Two links that differ only in
// tracking junk (`?utm_source=…`), a fragment (`#comments`), or host casing
// are the same post — and the module has to know that before it writes, or
// the UNIQUE constraint on `url_norm` is just a suggestion.
//
// `normalizeContentUrl` is the one canonicalizer: validation, dedupe keys,
// selector resolution and import idempotency all go through it.
import {
  CONTENT_LIMITS,
  CONTENT_PLATFORMS,
  ContentError,
  type ContentPlatform,
} from "./types";

/**
 * Query params that identify the *click*, not the *content*. Stripped from
 * the dedupe key (and only from the key — `url` keeps the original link).
 * `utm_*` by prefix, the rest by exact name.
 */
const TRACKING_PARAMS = new Set([
  "gclid",
  "gclsrc",
  "wbraid",
  "gbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "twclid",
  "ttclid",
  "srsltid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * Canonicalize a content URL into its dedupe key:
 *
 *   * absolute `http(s)` only — relative links, `javascript:`, `mailto:`
 *     and friends are rejected, not guessed;
 *   * scheme + host lower-cased, default ports (`:80`/`:443`) dropped;
 *   * fragment dropped; trailing slashes stripped from the path
 *     (`https://a.com/` and `https://a.com` are the same post);
 *   * tracking params removed, survivors sorted by name so
 *     `?b=2&a=1` and `?a=1&b=2` key identically.
 *
 * Throws `ContentError(invalid_input)` when the text is not a usable link.
 */
export function normalizeContentUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ContentError("invalid_input", "A content URL is required.");
  }
  if (trimmed.length > CONTENT_LIMITS.url) {
    throw new ContentError(
      "invalid_input",
      `"url" must be ${CONTENT_LIMITS.url} characters or fewer.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ContentError(
      "invalid_input",
      `"${trimmed.slice(0, 80)}" is not an absolute URL (expected https://…).`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContentError(
      "invalid_input",
      `Only http(s) URLs can be tracked (got "${parsed.protocol.slice(0, -1)}").`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || host.includes(" ") || host.includes("_")) {
    throw new ContentError(
      "invalid_input",
      `"${trimmed.slice(0, 80)}" is not a usable link.`,
    );
  }
  const defaultPort =
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443");
  const port = parsed.port && !defaultPort ? `:${parsed.port}` : "";

  const path = parsed.pathname.replace(/\/+$/, "");
  const kept: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }
  kept.sort(([aName, aValue], [bName, bValue]) =>
    aName === bName
      ? aValue < bValue
        ? -1
        : aValue > bValue
          ? 1
          : 0
      : aName < bName
        ? -1
        : 1,
  );
  const query = kept
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");

  return `${parsed.protocol}//${host}${port}${path}${query ? `?${query}` : ""}`;
}

/**
 * `true` when the text parses as an absolute http(s) URL — the cheap
 * pre-check import paths use before paying for full normalization.
 */
export function isTrackableUrl(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Host suffix → platform, longest-suffix-wins. `www.` is ignored. */
const PLATFORM_HOSTS: Array<{ suffix: string; platform: ContentPlatform }> = [
  { suffix: "dev.to", platform: "devto" },
  { suffix: "x.com", platform: "x" },
  { suffix: "twitter.com", platform: "twitter" },
  { suffix: "youtube.com", platform: "youtube" },
  { suffix: "youtu.be", platform: "youtube" },
  { suffix: "github.com", platform: "github" },
  { suffix: "linkedin.com", platform: "linkedin" },
];

/**
 * Guess the platform from the URL's host. Returns `null` for anything
 * unrecognized — the caller, not this function, decides the fallback
 * (`blog` for imports, explicit platform for direct adds).
 */
export function detectPlatform(rawUrl: string): ContentPlatform | null {
  let host: string;
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const { suffix, platform } of PLATFORM_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return platform;
  }
  return null;
}

/**
 * Validate an explicit platform cell: case-insensitive, `x`/`twitter` kept
 * distinct (the whitelist lists both), anything else an error that names the
 * allowed values.
 */
export function parsePlatform(raw: string | null | undefined): ContentPlatform {
  const value = raw?.trim().toLowerCase() ?? "";
  if ((CONTENT_PLATFORMS as readonly string[]).includes(value))
    return value as ContentPlatform;
  throw new ContentError(
    "invalid_input",
    `Unknown platform "${raw?.trim() ?? ""}". Expected one of: ${CONTENT_PLATFORMS.join(", ")}.`,
  );
}
