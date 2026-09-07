// packages/core/src/search/conditions.ts
//
// Dialect-agnostic WHERE/ORDER-BY construction for contacts search.
//
// The search filters are expressed with Drizzle's raw `sql` template against
// `AnyColumn` references rather than the per-dialect column classes
// (`SQLiteText` vs `PgText`). A raw-SQL fragment is identical for SQLite and
// Postgres, so this ONE module builds the conditions used by both branches of
// `query.ts` — avoiding the `if (dialect === 'sqlite') { ... } else { ... }`
// duplication the import/enrichment pipelines have to do for their typed
// query-builder calls. The only dialect-specific input is the set of column
// references passed in.
import { and, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SearchSort } from "./types";
import { canonicalSkill } from "../skills/taxonomy";

/** Structural view of the contacts columns the search touches. */
export interface ContactsColumns {
  fullName: AnyColumn;
  email: AnyColumn;
  headline: AnyColumn;
  company: AnyColumn;
  role: AnyColumn;
  seniority: AnyColumn;
  industry: AnyColumn;
  location: AnyColumn;
  relationshipScore: AnyColumn;
  lastInteraction: AnyColumn;
  deletedAt: AnyColumn;
  /** Derived skills verdict (JSON array text) — v2.0 Phase 5. */
  skills: AnyColumn;
}

export interface PreparedTermFilters {
  /** Whitespace-split free-text terms (already trimmed/non-empty). */
  terms: string[];
  /** ISO timestamp cutoff for lastActiveWithinDays, or null. */
  cutoff: string | null;
  /** The full lowercased free-text query, used for relevance ranking. */
  fullQuery: string | null;
}

const SEARCHABLE_COLUMNS = [
  "fullName",
  "email",
  "headline",
  "company",
  "role",
  "location",
] as const;

/**
 * Combine all active filters into a single AND-edited SQL condition.
 * Soft-deleted contacts are always excluded. Returns `undefined` only if
 * (impossibly) no conditions were produced.
 */
export function buildSearchConditions(
  c: ContactsColumns,
  opts: {
    company?: string;
    role?: string;
    location?: string;
    industry?: string;
    seniority?: string;
    hasEmail?: boolean;
    minScore?: number;
    skills?: string[];
  },
  filters: PreparedTermFilters,
): SQL | undefined {
  const conds: SQL[] = [sql`${c.deletedAt} IS NULL`];

  // Free-text: every term must match (case-insensitive substring) in at least
  // one searchable column — AND across terms, OR across columns per term.
  for (const term of filters.terms) {
    const needle = "%" + term.toLowerCase() + "%";
    conds.push(
      sql`(
        ${SEARCHABLE_COLUMNS.map(
          (col) => sql`lower(${c[col]}) LIKE ${needle}`,
        ).reduce((acc, part) => (acc ? sql`${acc} OR ${part}` : part))}
      )`,
    );
  }

  const icontains = (col: AnyColumn, value: string | undefined): void => {
    if (value)
      conds.push(sql`lower(${col}) LIKE ${"%" + value.toLowerCase() + "%"}`);
  };
  icontains(c.company, opts.company);
  icontains(c.role, opts.role);
  icontains(c.location, opts.location);
  icontains(c.industry, opts.industry);

  if (opts.seniority) conds.push(sql`${c.seniority} = ${opts.seniority}`);
  if (opts.hasEmail)
    conds.push(sql`${c.email} IS NOT NULL AND ${c.email} <> ''`);
  if (typeof opts.minScore === "number") {
    conds.push(sql`${c.relationshipScore} >= ${opts.minScore}`);
  }
  if (filters.cutoff) {
    conds.push(
      sql`${c.lastInteraction} IS NOT NULL AND ${c.lastInteraction} >= ${filters.cutoff}`,
    );
  }

  // Skills: the verdict is a JSON array of canonical names stored as text in
  // both dialects, so a quoted-name substring test is exact (names never
  // contain quotes) and portable — no JSON operators, no dialect branch. An
  // unknown name yields a condition that matches nothing rather than being
  // dropped: a typo must narrow the result to zero, never silently widen it.
  for (const raw of opts.skills ?? []) {
    const skill = canonicalSkill(raw);
    if (!skill) {
      conds.push(sql`1 = 0`);
      break;
    }
    conds.push(sql`${c.skills} IS NOT NULL AND ${c.skills} LIKE ${"%\"" + skill + "\"%"}`);
  }

  return and(...conds) ?? undefined;
}

/**
 * Build the ORDER BY clause. `relevance` ranks name > email > company >
 * role/headline/location matches against the full query string, then falls
 * back to relationship score; the other sorts are direct column orderings.
 * `NULLS LAST` (supported by both SQLite ≥ 3.30 and Postgres) keeps contacts
 * with no recorded interaction from sorting to the top of "recent".
 */
export function buildOrderBy(
  c: ContactsColumns,
  sort: SearchSort,
  fullQuery: string | null,
): SQL[] {
  const nameAsc = sql`${c.fullName} ASC`;

  if (sort === "name") {
    return [nameAsc];
  }

  if (sort === "score") {
    return [sql`${c.relationshipScore} DESC`, nameAsc];
  }

  if (sort === "recent") {
    return [sql`${c.lastInteraction} DESC NULLS LAST`, nameAsc];
  }

  // relevance
  if (fullQuery) {
    const q = "%" + fullQuery + "%";
    const rank = sql`(
      CASE
        WHEN lower(${c.fullName}) LIKE ${q} THEN 4
        WHEN lower(${c.email}) LIKE ${q} THEN 3
        WHEN lower(${c.company}) LIKE ${q} THEN 2
        WHEN lower(${c.role}) LIKE ${q}
          OR lower(${c.headline}) LIKE ${q}
          OR lower(${c.location}) LIKE ${q} THEN 1
        ELSE 0
      END
    )`;
    return [sql`${rank} DESC`, sql`${c.relationshipScore} DESC`, nameAsc];
  }

  // No query text: "relevance" degrades to relationship-score ordering.
  return [sql`${c.relationshipScore} DESC`, nameAsc];
}
