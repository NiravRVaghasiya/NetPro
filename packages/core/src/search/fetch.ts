// packages/core/src/search/fetch.ts
//
// Row/facet/page fetching shared by both search engines.
//
// Extracted from query.ts in v2.0 Phase 4 so the portable engine and the
// hybrid fusion engine read contacts through exactly one code path — the
// cheapest way to guarantee the "filter/sort/pagination parity" the phase plan
// asks for. The dialect branches live here and nowhere else.
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  FACET_LIMIT,
  type ContactSearchResult,
  type FacetBucket,
  type SearchFacets,
} from "./types";
import type { ContactsColumns } from "./conditions";

export type Conn = SqliteConn | PgConn;

/** The contacts columns search reads, pulled off whichever dialect schema. */
export function contactColumns(conn: Conn): ContactsColumns {
  const t = conn.schema.contacts;
  return {
    id: t.id,
    fullName: t.fullName,
    email: t.email,
    headline: t.headline,
    company: t.company,
    role: t.role,
    seniority: t.seniority,
    industry: t.industry,
    location: t.location,
    relationshipScore: t.relationshipScore,
    lastInteraction: t.lastInteraction,
    deletedAt: t.deletedAt,
    skills: t.skills,
    tags: t.tags,
    workspaceId: t.workspaceId,
  };
}

export interface PageRow {
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
  /** Raw JSON-array column: an array on SQLite (json mode), text on Postgres. */
  tags: unknown;
  /** Raw JSON-array column: an array on SQLite (json mode), text on Postgres. */
  skills: unknown;
}

/**
 * Parse a JSON-array contact column (Phase 12).
 *
 * SQLite's json-mode columns arrive as arrays; the Postgres schema stores the
 * same JSON as plain text. Both shapes — plus null/blank/corrupt — collapse
 * here so every surface sees `string[] | null` regardless of dialect.
 */
export function parseStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function mapRow(r: PageRow): ContactSearchResult {
  return {
    id: r.id,
    fullName: r.fullName,
    email: r.email,
    headline: r.headline,
    company: r.company,
    role: r.role,
    seniority: r.seniority,
    industry: r.industry,
    location: r.location,
    linkedinUrl: r.linkedinUrl,
    relationshipScore: r.relationshipScore,
    lastInteraction: r.lastInteraction,
    source: r.source,
    tags: parseStringArray(r.tags),
    skills: parseStringArray(r.skills),
  };
}

export async function runPage(
  conn: Conn,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
): Promise<{ rows: PageRow[]; total: number }> {
  if (conn.dialect === "sqlite") {
    const db = conn.db;
    const rows = db
      .select()
      .from(conn.schema.contacts)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all() as unknown as PageRow[];
    const countRows = db
      .select({ n: sql<number>`count(*)` })
      .from(conn.schema.contacts)
      .where(where)
      .all() as unknown as Array<{ n: number }>;
    return { rows, total: Number(countRows[0]?.n ?? 0) };
  }

  const db = conn.db;
  const rows = (await db
    .select()
    .from(conn.schema.contacts)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset)) as unknown as PageRow[];
  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(conn.schema.contacts)
    .where(where);
  return { rows, total: Number(countRows[0]?.n ?? 0) };
}

/** Page without the COUNT — the fused engine already knows its total. */
export async function runRows(
  conn: Conn,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
): Promise<PageRow[]> {
  if (conn.dialect === "sqlite") {
    return conn.db
      .select()
      .from(conn.schema.contacts)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all() as unknown as PageRow[];
  }
  return (await conn.db
    .select()
    .from(conn.schema.contacts)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset)) as unknown as PageRow[];
}

export async function runFacets(
  conn: Conn,
  cols: ContactsColumns,
  where: SQL | undefined,
): Promise<SearchFacets> {
  const aggregate = async (col: AnyColumn): Promise<FacetBucket[]> => {
    const valueExpr = sql<string>`lower(${col})`;
    const facetWhere = where
      ? sql`${where} AND ${col} IS NOT NULL AND ${col} <> ''`
      : sql`${col} IS NOT NULL AND ${col} <> ''`;

    if (conn.dialect === "sqlite") {
      const res = conn.db
        .select({ value: valueExpr, count: sql<number>`count(*)` })
        .from(conn.schema.contacts)
        .where(facetWhere)
        .groupBy(valueExpr)
        .orderBy(sql`count(*) DESC`)
        .limit(FACET_LIMIT)
        .all() as unknown as Array<{ value: string; count: number }>;
      return res.map((r) => ({ value: r.value, count: Number(r.count) }));
    }

    const res = (await conn.db
      .select({ value: valueExpr, count: sql<number>`count(*)` })
      .from(conn.schema.contacts)
      .where(facetWhere)
      .groupBy(valueExpr)
      .orderBy(sql`count(*) DESC`)
      .limit(FACET_LIMIT)) as unknown as Array<{
      value: string;
      count: number;
    }>;
    return res.map((r) => ({ value: r.value, count: Number(r.count) }));
  };

  const [company, role, location, seniority, industry] = await Promise.all([
    aggregate(cols.company),
    aggregate(cols.role),
    aggregate(cols.location),
    aggregate(cols.seniority),
    aggregate(cols.industry),
  ]);

  return {
    company: company ?? [],
    role: role ?? [],
    location: location ?? [],
    seniority: seniority ?? [],
    industry: industry ?? [],
  };
}

export const EMPTY_FACETS: SearchFacets = {
  company: [],
  role: [],
  location: [],
  seniority: [],
  industry: [],
};

/** `id IN (…)` for a bounded id list, or a never-true condition when empty. */
export function idInList(
  cols: ContactsColumns,
  conn: Conn,
  ids: string[],
): SQL {
  const idColumn = conn.schema.contacts.id;
  if (ids.length === 0) return sql`1 = 0`;
  return sql`${idColumn} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
