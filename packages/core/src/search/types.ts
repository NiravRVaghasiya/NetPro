// packages/core/src/search/types.ts

export type SearchSort = "relevance" | "score" | "recent" | "name";

/**
 * Which engine `searchContacts` should run (v2.0 Phase 4).
 *
 *  - `portable` — the v1 engine: case-insensitive substring + facets in ANSI
 *    SQL, identical on both dialects. **The default: no config, no behaviour
 *    change.**
 *  - `keyword`  — adds the dialect-native full-text arm (SQLite FTS5 /
 *    Postgres `tsvector`) and fuses it with the portable arm via RRF.
 *  - `hybrid`   — `keyword` plus the semantic (embedding) arm, when
 *    embeddings are configured *and* contacts have been indexed.
 *
 * `keyword`/`hybrid` degrade rather than fail: a missing index, an empty
 * index, or an embeddings provider that is down each drop their arm and are
 * reported in {@link SearchArmReport}. A request that loses every non-portable
 * arm returns exactly what `portable` would have returned.
 */
export type SearchMode = "portable" | "keyword" | "hybrid";

export const SEARCH_MODES: SearchMode[] = ["portable", "keyword", "hybrid"];

export function isSearchMode(value: unknown): value is SearchMode {
  return (
    typeof value === "string" && (SEARCH_MODES as string[]).includes(value)
  );
}

/**
 * Options for {@link searchContacts}. Every field is optional; an empty
 * options object returns all (non-deleted) contacts paginated.
 *
 * The text/company/role/location/industry fields are case-insensitive
 * substring matches; `seniority` is an exact match against the normalized
 * seniority vocabulary produced by import normalization
 * (`intern|junior|mid|senior|lead|director|vp|c_level`).
 *
 * NOTE: `--skills`/`--open-to-connect` from the blueprint's CLI reference are
 * not represented here — contacts carry no skills column and there is no
 * open-to-connect signal in this phase. They become filterable once later
 * phases populate that data.
 */
export interface SearchContactsOptions {
  /** Free-text query; matches name, email, headline, company, role, location. */
  query?: string;
  company?: string;
  role?: string;
  location?: string;
  industry?: string;
  /** Exact normalized seniority level, e.g. `senior`, `c_level`. */
  seniority?: string;
  /** Only contacts with a non-empty email address. */
  hasEmail?: boolean;
  /** Minimum relationship score (0–1). */
  minScore?: number;
  /** Only contacts with a recorded interaction within the last N days. */
  lastActiveWithinDays?: number;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  /** Engine selection; defaults to `portable` (v1 behaviour). */
  mode?: SearchMode;
}

/** A flattened contact row as returned by search — the shape both surfaces use. */
export interface ContactSearchResult {
  id: string;
  fullName: string;
  email: string | null;
  headline: string | null;
  company: string | null;
  role: string | null;
  seniority: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  relationshipScore: number | null;
  lastInteraction: string | null;
  source: string;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface SearchFacets {
  company: FacetBucket[];
  role: FacetBucket[];
  location: FacetBucket[];
  seniority: FacetBucket[];
  industry: FacetBucket[];
}

export interface SearchContactsResponse {
  contacts: ContactSearchResult[];
  /** Total matches across all pages (before limit/offset). */
  total: number;
  limit: number;
  offset: number;
  facets: SearchFacets;
  /**
   * How the results were actually produced. Always present: `portable`
   * responses report `mode: 'portable'` with no arms, so callers can render an
   * honest badge without branching on the request.
   */
  engine: SearchEngineReport;
}

/** Per-arm outcome, so the UI can say *why* an arm did not contribute. */
export interface SearchArmReport {
  /** Did this arm contribute a ranked list? */
  used: boolean;
  /** Candidates the arm returned (0 when skipped). */
  hits: number;
  /** Machine-readable reason when `used` is false. */
  reason?: SearchArmSkipReason;
  /** Human-readable detail (provider error text, capped). */
  detail?: string;
}

export type SearchArmSkipReason =
  /** The caller asked for `portable`, or there is no free-text query to rank. */
  | "not_requested"
  /** `search_index` has no row for any candidate — nothing to full-text match. */
  | "index_empty"
  /** The dialect-native index is missing (migration 0004 not applied). */
  | "index_missing"
  /** No embeddings provider configured (`EMBEDDINGS_PROVIDER=disabled`). */
  | "not_configured"
  /** No contact carries a usable stored embedding for the configured model. */
  | "no_embeddings"
  /** The provider call failed; keyword/portable results were returned instead. */
  | "provider_error";

export interface SearchEngineReport {
  /** The mode actually served (may be lower than requested after degradation). */
  mode: SearchMode;
  /** The mode the caller asked for. */
  requested: SearchMode;
  arms: {
    portable: SearchArmReport;
    keyword: SearchArmReport;
    semantic: SearchArmReport;
  };
  /** True when fused candidates hit {@link HYBRID_POOL_LIMIT} and `total` is a floor. */
  truncated: boolean;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const FACET_LIMIT = 10;

/**
 * How many fused candidates a keyword/hybrid request will consider.
 *
 * Fusion happens in JS, so the pool has to be bounded. 500 is ~20 pages at the
 * default page size and comfortably above what a single owner scrolls; past it
 * the response reports `engine.truncated` rather than pretending `total` is
 * exact. Each arm contributes at most this many rows.
 */
export const HYBRID_POOL_LIMIT = 500;

/**
 * Ceiling on stored vectors loaded for one semantic query. Cosine similarity
 * is brute-forced in JS (no pgvector dependency — see the Phase 4 progress
 * doc), which is ~1 ms per 1k 1536-dim vectors; 5k rows keeps the arm inside
 * the search latency budget on a single-owner database.
 */
export const SEMANTIC_SCAN_LIMIT = 5000;

/** RRF's smoothing constant. 60 is the value from Cormack et al. (2009). */
export const RRF_K = 60;

const NOT_RUN: SearchArmReport = { used: false, hits: 0, reason: "not_requested" };

/** The engine report a pure-portable response carries. */
export function portableEngineReport(
  requested: SearchMode = "portable",
): SearchEngineReport {
  return {
    mode: "portable",
    requested,
    arms: { portable: { used: true, hits: 0 }, keyword: NOT_RUN, semantic: NOT_RUN },
    truncated: false,
  };
}

/**
 * Normalize raw caller options into concrete, bounded values. Pure — used by
 * both the SQLite and Postgres query paths so they behave identically.
 */
export function normalizeSearchOptions(
  opts: SearchContactsOptions = {},
): Required<Pick<SearchContactsOptions, "sort" | "limit" | "offset">> & {
  terms: string[];
  cutoff: string | null;
  mode: SearchMode;
} {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sort: SearchSort = opts.sort ?? "relevance";
  const mode: SearchMode = isSearchMode(opts.mode) ? opts.mode : "portable";

  const terms = (opts.query ?? "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const cutoff =
    typeof opts.lastActiveWithinDays === "number" &&
    opts.lastActiveWithinDays > 0
      ? new Date(
          Date.now() - opts.lastActiveWithinDays * 24 * 60 * 60 * 1000,
        ).toISOString()
      : null;

  return { sort, limit, offset, terms, cutoff, mode };
}
