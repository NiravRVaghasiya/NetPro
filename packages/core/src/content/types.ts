// packages/core/src/content/types.ts
//
// v2.5 Phase 4 — the content tracker's vocabulary, limits and errors.
//
// The blueprint's second v2.5 feature: a unified view of what you publish
// across the web (blog, Twitter/X, dev.to, …) and how each piece performs —
// without handing your reading list to a third party. This phase is the data
// model and the provider seam only: migration `0007` plus the pure helpers
// and repository functions the Phase 5 surfaces (`netpro content`, `/content`,
// `/api/content`) will consume.
//
// Three rules carry through the whole module:
//
//   1. **The normalized URL is the identity.** `url` is kept as given (so the
//      link still renders and still works), but dedupe, idempotency and the
//      UNIQUE constraint all key on `url_norm` — lower-cased host, no
//      fragment, tracking params stripped, query sorted. Re-importing the
//      same file or feed can never double-count a post.
//   2. **No network without an explicit fetch.** Parsing (CSV, RSS/Atom) is
//      pure text-in/rows-out; the only network call in the module is
//      `fetchFeedText`, which takes an injectable fetch, a byte cap and a
//      timeout. Disabled providers are values that explain themselves, never
//      silent no-ops and never 500s.
//   3. **Missing metrics are null, not zero.** A provider that reports likes
//      but not views must not drag the view total down: `null` means
//      "unreported" and is excluded from sums, `0` means "reported zero".
export const MODULE_NAME = "content";

/** Where a piece of content lives. Fixed whitelist — unknown hosts are `blog`/`manual`. */
export const CONTENT_PLATFORMS = [
  "blog",
  "twitter",
  "x",
  "devto",
  "linkedin",
  "youtube",
  "github",
  "manual",
  "rss",
] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number];

/** What kind of thing it is. Nullable on the row — feeds rarely say. */
export const CONTENT_TYPES = [
  "article",
  "post",
  "video",
  "thread",
  "repo",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** How the row arrived. `provider` is reserved for future API-backed providers. */
export const CONTENT_SOURCES = ["manual", "import", "rss", "provider"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

/** Who reported a metrics snapshot. API names are reserved for Phase 5+ providers. */
export const METRIC_SOURCES = [
  "manual",
  "rss",
  "import",
  "twitter_api",
  "devto_api",
  "github_api",
] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const CONTENT_LIMITS = {
  url: 2048,
  title: 300,
  author: 200,
  summary: 2000,
  /** Tags kept per item (feeds can emit dozens of categories). */
  tags: 20,
  tagLength: 50,
  /** Per-mention free text ("co-authored", "mentioned"). */
  mentionContext: 120,
  /** Items accepted in a single import (CSV rows or feed entries). */
  itemsPerImport: 1_000,
  /** Metrics snapshots kept per item query — the series, not the archive. */
  metricsPerItem: 365,
  /** Largest feed body accepted, in bytes (Content-Length gate + stream cap). */
  feedMaxBytes: 1_000_000,
  /** Feed fetch timeout. */
  feedTimeoutMs: 10_000,
  /** CSV cells that flow into capped columns. */
  query: 200,
} as const;

export type ContentErrorCode =
  "invalid_input" | "not_found" | "conflict" | "not_configured";

export class ContentError extends Error {
  readonly code: ContentErrorCode;
  constructor(code: ContentErrorCode, message: string) {
    super(message);
    this.name = "ContentError";
    this.code = code;
  }
}

export interface ContentOptions {
  now?: Date;
}

export function resolveNow(opts: ContentOptions = {}): Date {
  return opts.now ?? new Date();
}

/** A row of `content_items`. */
export interface ContentItem {
  id: string;
  url: string;
  urlNorm: string;
  title: string;
  platform: string;
  type: string | null;
  publishedAt: string | null;
  author: string | null;
  tags: string[];
  summary: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** One row of `content_metrics` — a snapshot, never an update. */
export interface ContentMetric {
  id: string;
  contentId: string;
  fetchedAt: string;
  source: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  bookmarks: number | null;
  rawPayload: Record<string, unknown> | null;
  createdAt: string;
}

/** A contact linked to a piece of content, with the live contact attached. */
export interface ContentMention {
  contentId: string;
  contactId: string;
  fullName: string;
  email: string | null;
  context: string | null;
}

/** Latest-known engagement for one item (`null` when never measured). */
export interface ContentItemSummary extends ContentItem {
  latestMetrics: ContentMetric | null;
  metricsCount: number;
  mentionsCount: number;
}

export interface ContentStatus {
  items: number;
  withMetrics: number;
  snapshots: number;
  mentions: number;
}
