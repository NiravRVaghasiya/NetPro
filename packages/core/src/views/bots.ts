// v2.5 Phase 1 — bot detection for profile views.
//
// `profile_views.is_bot` is set by the ingestion pipeline (Phase 2) using
// these vendored markers plus a conservative token backstop. The list is
// intentionally a **deny-list of known crawlers/preview fetchers**, never an
// allow-list of browsers: an unknown UA is assumed human and counted, which
// errs toward "show me the view" (the analytics surface offers an
// include-bots toggle for debugging). Two deliberate non-targets:
//
//   * Generic HTTP clients (`curl`, `python-requests`, …) are *not* bots
//     here — they are usually the owner's own tools, and owner views are
//     excluded by `is_owner_view`, not by bot labeling.
//   * UA-less requests are not bots either; `viewed_page`/endpoint-level
//     rate limits (Phase 2) cover abuse.
//
// The backstop tokenizes the UA on non-alphanumerics and flags any token
// ending in `bot` / `crawler` / `spider` (length ≥ 3). That catches
// glue-named crawlers the vendored list has not met yet (`FooBot/1.0`,
// `MJ12bot/1.0`) without tripping on plain English: `robots`, `robotnik` or
// `spiders web` never end in those suffixes.
export interface BotUaMarker {
  /** Lowercase substring matched against the user agent. */
  marker: string;
  /** Coarse bucket used for debugging and the analytics breakdown. */
  group: string;
}

export const BOT_UA_MARKERS: BotUaMarker[] = [
  // Search engines & assistants.
  { marker: 'googlebot', group: 'search-engine' },
  { marker: 'bingbot', group: 'search-engine' },
  { marker: 'slurp', group: 'search-engine' }, // Yahoo
  { marker: 'duckduckbot', group: 'search-engine' },
  { marker: 'baiduspider', group: 'search-engine' },
  { marker: 'yandexbot', group: 'search-engine' },
  { marker: 'sogou', group: 'search-engine' },
  { marker: 'exabot', group: 'search-engine' },
  { marker: 'petalbot', group: 'search-engine' },
  { marker: 'applebot', group: 'search-engine' },
  { marker: 'seznambot', group: 'search-engine' },
  { marker: 'yeti', group: 'search-engine' }, // Naver
  { marker: 'qwantify', group: 'search-engine' },
  // Social & messaging link-preview fetchers.
  { marker: 'facebookexternalhit', group: 'social' },
  { marker: 'linkedinbot', group: 'social' },
  { marker: 'twitterbot', group: 'social' },
  { marker: 'whatsapp', group: 'social' },
  { marker: 'telegrambot', group: 'social' },
  { marker: 'discordbot', group: 'social' },
  { marker: 'slackbot', group: 'social' },
  { marker: 'skypeuripreview', group: 'social' },
  { marker: 'pinterest', group: 'social' },
  { marker: 'redditbot', group: 'social' },
  { marker: 'instagram', group: 'social' },
  { marker: 'embedly', group: 'social' },
  { marker: 'quora link', group: 'social' },
  // AI crawlers (opt-out signals honored upstream; we only label the hit).
  { marker: 'gptbot', group: 'ai-crawler' },
  { marker: 'anthropic-ai', group: 'ai-crawler' },
  { marker: 'claude-ai', group: 'ai-crawler' },
  { marker: 'claudebot', group: 'ai-crawler' },
  { marker: 'perplexitybot', group: 'ai-crawler' },
  { marker: 'bytespider', group: 'ai-crawler' },
  { marker: 'ccbot', group: 'ai-crawler' }, // Common Crawl
  { marker: 'amazonbot', group: 'ai-crawler' },
  { marker: 'meta-externalagent', group: 'ai-crawler' },
  { marker: 'omgili', group: 'ai-crawler' },
  { marker: 'imagesiftbot', group: 'ai-crawler' },
  { marker: 'diffbot', group: 'ai-crawler' },
  { marker: 'cohere-ai', group: 'ai-crawler' },
  // SEO & analytics crawlers.
  { marker: 'ahrefsbot', group: 'seo' },
  { marker: 'semrushbot', group: 'seo' },
  { marker: 'rogerbot', group: 'seo' }, // Moz
  { marker: 'majestic-12', group: 'seo' },
  { marker: 'dotbot', group: 'seo' },
  { marker: 'seokicks', group: 'seo' },
  { marker: 'serpstatbot', group: 'seo' },
  { marker: 'dataforseobot', group: 'seo' },
  // Archivers & availability monitors.
  { marker: 'ia_archiver', group: 'archiver' }, // Internet Archive
  { marker: 'archive.org_bot', group: 'archiver' },
  { marker: 'domaincrawler', group: 'archiver' },
  { marker: 'uptimerobot', group: 'monitoring' },
  { marker: 'pingdom', group: 'monitoring' },
];

/** UA tokens (lowercased). Everything non-alphanumeric is a separator. */
const UA_TOKEN_PATTERN = /[a-z0-9][a-z0-9._+-]*/g;

/**
 * Backstop for crawlers not worth a dedicated marker: any token ending in
 * `bot`, `crawler` or `spider` (min length 3). Glue-named crawlers such as
 * `FooBot` or `MJ12bot` therefore match, while browser tokens (`chrome`,
 * `safari`, `firefox`), versions (`126.0.0.0`) and harmless English
 * (`robots.txt` → `robots`, `spiders web` → `spiders`) do not.
 */
function isBotWordToken(token: string): boolean {
  return (
    token.length >= 3 &&
    (token.endsWith('bot') || token.endsWith('crawler') || token.endsWith('spider'))
  );
}

export interface BotClassification {
  isBot: boolean;
  /** Which marker matched, or the generic word, or null. */
  marker: string | null;
  /** Marker group (or 'generic' for the word backstop), else null. */
  group: string | null;
}

/** Classify one `User-Agent` header value. Empty/absent UA ⇒ not a bot. */
export function classifyUserAgent(ua: string | null | undefined): BotClassification {
  if (!ua) return { isBot: false, marker: null, group: null };
  const lower = ua.toLowerCase();
  for (const { marker, group } of BOT_UA_MARKERS) {
    if (lower.includes(marker)) return { isBot: true, marker, group };
  }
  const tokens = lower.match(UA_TOKEN_PATTERN) ?? [];
  for (const token of tokens) {
    if (isBotWordToken(token)) {
      return { isBot: true, marker: token, group: 'generic' };
    }
  }
  return { isBot: false, marker: null, group: null };
}

/** True when the user agent belongs to a known bot / crawler / fetcher. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  return classifyUserAgent(ua).isBot;
}
