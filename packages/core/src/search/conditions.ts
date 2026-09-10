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
import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SearchSort } from "./types";
import { canonicalSkill } from "../skills/taxonomy";
import { resolveScope, type WorkspaceScope } from "../workspaces/scope";

/** Structural view of the contacts columns the search touches. */
export interface ContactsColumns {
  id: AnyColumn;
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
  /** Free-form tags (JSON array text) — Phase 12. */
  tags: AnyColumn;
  /** Tenancy column (v3.0 Phase 2) — every search query is scoped through it. */
  workspaceId: AnyColumn;
}

export interface PreparedTermFilters {
  /** Whitespace-split free-text terms (already trimmed/non-empty). */
  terms: string[];
  /** ISO timestamp cutoff for lastActiveWithinDays, or null. */
  cutoff: string | null;
  /** The full lowercased free-text query, used for relevance ranking. */
  fullQuery: string | null;
}

/**
 * Columns the free-text terms match against. Exported so the Phase 12 match
 * explainer attributes terms to exactly the fields the SQL tests — one list,
 * two readers, no drift.
 */
export const SEARCHABLE_COLUMNS = [
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
    name?: string;
    company?: string;
    role?: string;
    location?: string;
    industry?: string;
    seniority?: string;
    hasEmail?: boolean;
    minScore?: number;
    skills?: string[];
    tags?: string[];
    contactIds?: string[];
  },
  filters: PreparedTermFilters,
  scope?: WorkspaceScope,
): SQL | undefined {
  // v3.0 Phase 2 — tenancy is a condition like any other here so that the
  // portable engine, the keyword/semantic arms (whose filter fragment is
  // built by this function), pages, and facets all inherit it.
  const conds: SQL[] = [
    sql`${c.deletedAt} IS NULL`,
    eq(c.workspaceId, resolveScope(scope).workspaceId),
  ];

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
  icontains(c.fullName, opts.name);
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
    conds.push(
      sql`${c.skills} IS NOT NULL AND ${c.skills} LIKE ${'%"' + skill + '"%'}`,
    );
  }

  // Tags (Phase 12): same quoted-match trick as skills, but case-insensitive
  // — tags are free-form owner labels, not taxonomy names. Quotes are
  // stripped from the needle so a malicious tag cannot break out of the
  // quoted match; a tag containing a quote simply matches nothing.
  for (const raw of opts.tags ?? []) {
    const tag = raw.trim().toLowerCase().replace(/"/g, "");
    if (!tag) continue;
    conds.push(
      sql`${c.tags} IS NOT NULL AND lower(${c.tags}) LIKE ${'%"' + tag + '"%'}`,
    );
  }

  // Id-set restriction (Phase 12): the community filter resolves to member
  // ids before this runs, so every engine path shares one intersection
  // mechanism. An empty set matches nothing — never everything.
  if (opts.contactIds !== undefined) {
    if (opts.contactIds.length === 0) {
      conds.push(sql`1 = 0`);
    } else {
      conds.push(
        sql`${c.id} IN (${sql.join(
          opts.contactIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
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
