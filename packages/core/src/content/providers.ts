// packages/core/src/content/providers.ts
//
// The seam between "things NetPro can read by itself" and "things that need
// somebody else's API". The posture is the event discovery one: a
// single-owner tool ships no network call it cannot justify, so v2.5 builds
// the interface, two honest providers (`manual`, `rss`), and three disabled
// stubs (`devto`, `twitter`, `github`) that explain exactly what would enable
// them. A future phase — or a fork — adds a provider without touching the
// core, the CLI, or the web surface: implement `ContentProvider` and hand it
// to `resolveContentProviders`.
//
// Nothing here touches the network. `fetchMetrics` on an enabled provider is
// always an explicit, per-item call from Phase 5 surfaces — never a cron,
// never a background sweep.
import { fetchFeedText, parseFeedXml, type ParsedFeed } from "./parse";
import { ContentError } from "./types";

/** One engagement sample, as a provider reports it. Every field optional. */
export interface MetricSample {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  bookmarks?: number | null;
  /** The raw API payload, kept for debugging. Must be JSON-serializable. */
  rawPayload?: Record<string, unknown> | null;
}

export interface ContentProvider {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Could this provider handle this URL, were it called? */
  canFetch(url: string): boolean;
  /** Pull fresh engagement numbers for one URL. Absent when the provider has no metrics to give. */
  fetchMetrics?: (url: string) => Promise<MetricSample>;
  /** Parse a bulk body (feed XML today) into importable rows. */
  parse?: (input: string) => ParsedFeed;
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(url: string, suffixes: string[]): boolean {
  const host = hostOf(url);
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * The default provider: the owner reads the numbers off the platform and
 * types them in. It "handles" every URL because manual entry always works —
 * which is also why it has no `fetchMetrics` to call.
 */
export const MANUAL_PROVIDER: ContentProvider = {
  id: "manual",
  name: "Manual entry",
  enabled: true,
  canFetch: () => true,
};

function looksLikeFeedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const path = parsed.pathname.toLowerCase();
  return (
    /\/(feed|feeds|rss|atom)(\.(xml|rss|atom))?\/?$/.test(path) ||
    /\.(xml|rss|atom)$/.test(path) ||
    parsed.searchParams.get("format") === "xml" ||
    parsed.searchParams.get("feed") !== null
  );
}

/**
 * RSS/Atom: the only provider that reads the open web, and only what the
 * owner points it at. Feeds carry no engagement numbers, so this provider
 * parses (discovery) but never reports metrics.
 */
export const RSS_PROVIDER: ContentProvider = {
  id: "rss",
  name: "RSS/Atom feed",
  enabled: true,
  canFetch: looksLikeFeedUrl,
  parse: (input: string) => parseFeedXml(input),
};

/** Re-exported so Phase 5 surfaces fetch through the one bounded helper. */
export { fetchFeedText };

function disabledProvider(
  id: string,
  name: string,
  suffixes: string[],
  envHint: string,
): ContentProvider {
  return {
    id,
    name,
    enabled: false,
    canFetch: (url: string) => hostMatches(url, suffixes),
    fetchMetrics: async () => {
      // A disabled provider is a value with an explanation, not a 500: the
      // message names the key that would enable it.
      throw new ContentError(
        "not_configured",
        `${name} metrics are not configured (set ${envHint} to enable them).`,
      );
    },
  };
}

/** Public API, BYO key — stubbed until a phase implements the client. */
export const DEVTO_PROVIDER: ContentProvider = disabledProvider(
  "devto",
  "dev.to",
  ["dev.to"],
  "DEVTO_API_KEY",
);

/** Public API, BYO bearer token — stubbed until a phase implements the client. */
export const TWITTER_PROVIDER: ContentProvider = disabledProvider(
  "twitter",
  "Twitter/X",
  ["x.com", "twitter.com"],
  "TWITTER_BEARER_TOKEN",
);

/** Public API, optional token for rate limits — stubbed until a phase implements the client. */
export const GITHUB_PROVIDER: ContentProvider = disabledProvider(
  "github",
  "GitHub",
  ["github.com"],
  "GITHUB_TOKEN",
);

/** Every provider v2.5 ships, most specific first, `manual` last (it matches everything). */
export const CONTENT_PROVIDERS: readonly ContentProvider[] = [
  DEVTO_PROVIDER,
  TWITTER_PROVIDER,
  GITHUB_PROVIDER,
  RSS_PROVIDER,
  MANUAL_PROVIDER,
];

/**
 * Route a URL to its providers, most specific first. `manual` always matches,
 * so the result is never empty — the tail is the fallback, not a failure.
 */
export function resolveContentProviders(
  url: string,
  providers: readonly ContentProvider[] = CONTENT_PROVIDERS,
): ContentProvider[] {
  return providers.filter((p) => {
    try {
      return p.canFetch(url);
    } catch {
      return false;
    }
  });
}

/** True when the provider could actually report numbers right now. */
export function canFetchMetrics(provider: ContentProvider): boolean {
  return (
    provider.enabled === true && typeof provider.fetchMetrics === "function"
  );
}

/**
 * The first provider in route order that could report numbers for this URL
 * right now — or `null` when the honest answer is "type them in yourself".
 */
export function resolveMetricsProvider(
  url: string,
  providers: readonly ContentProvider[] = CONTENT_PROVIDERS,
): ContentProvider | null {
  return resolveContentProviders(url, providers).find(canFetchMetrics) ?? null;
}
