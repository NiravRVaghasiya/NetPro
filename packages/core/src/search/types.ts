// packages/core/src/search/types.ts

export type SearchSort = "relevance" | "score" | "recent" | "name";

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
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const FACET_LIMIT = 10;

/**
 * Normalize raw caller options into concrete, bounded values. Pure — used by
 * both the SQLite and Postgres query paths so they behave identically.
 */
export function normalizeSearchOptions(
  opts: SearchContactsOptions = {},
): Required<Pick<SearchContactsOptions, "sort" | "limit" | "offset">> & {
  terms: string[];
  cutoff: string | null;
} {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sort: SearchSort = opts.sort ?? "relevance";

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

  return { sort, limit, offset, terms, cutoff };
}
