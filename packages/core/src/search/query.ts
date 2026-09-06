// packages/core/src/search/query.ts
//
// Faceted people search over the contacts table.
//
// This is the v1 "portable" search: case-insensitive substring matching,
// exact seniority/score/activity filters, facets, and pagination — all in
// ANSI SQL that runs identically on SQLite and Postgres. The blueprint's
// hybrid engine (SQLite FTS5 + pgvector + 384-dim embeddings with RRF
// re-ranking) deliberately needs dialect-specific storage and is deferred to
// a later phase — it will build on the same `searchContacts` entry point.
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  normalizeSearchOptions,
  type SearchContactsOptions,
  type SearchContactsResponse,
  type ContactSearchResult,
  type FacetBucket,
  type SearchFacets,
  FACET_LIMIT,
} from "./types";
import {
  buildSearchConditions,
  buildOrderBy,
  type ContactsColumns,
  type PreparedTermFilters,
} from "./conditions";

export async function searchContacts(
  conn: SqliteConn | PgConn,
  options: SearchContactsOptions = {},
): Promise<SearchContactsResponse> {
  const { sort, limit, offset, terms, cutoff } =
    normalizeSearchOptions(options);
  const prepared: PreparedTermFilters = {
    terms,
    cutoff,
    fullQuery: terms.length > 0 ? terms.join(" ").toLowerCase() : null,
  };

  const t = conn.schema.contacts;
  const cols: ContactsColumns = {
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
  };

  const where = buildSearchConditions(cols, options, prepared);
  const orderBy = buildOrderBy(cols, sort, prepared.fullQuery);

  // Dialect query-builder overloads still differ (the load-bearing
  // `conn.dialect` narrowing used across import/enrichment), so the
  // condition/order construction is shared above while each dialect executes
  // its own builder below.
  const { rows, total } =
    conn.dialect === "sqlite"
      ? await runPage(conn, cols, where, orderBy, limit, offset, "sqlite")
      : await runPage(conn, cols, where, orderBy, limit, offset, "pg");

  const facets =
    conn.dialect === "sqlite"
      ? await runFacets(conn, cols, where, "sqlite")
      : await runFacets(conn, cols, where, "pg");

  return {
    contacts: rows.map(mapRow),
    total,
    limit,
    offset,
    facets,
  };
}

interface PageRow {
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

function mapRow(r: PageRow): ContactSearchResult {
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
  };
}

async function runPage(
  conn: SqliteConn | PgConn,
  cols: ContactsColumns,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  dialect: "sqlite" | "pg",
): Promise<{ rows: PageRow[]; total: number }> {
  if (dialect === "sqlite" && conn.dialect === "sqlite") {
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

  if (conn.dialect === "postgresql") {
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

  // Unreachable: dialect matches conn.dialect.
  throw new Error("runPage: dialect/connection mismatch");
}

async function runFacets(
  conn: SqliteConn | PgConn,
  cols: ContactsColumns,
  where: SQL | undefined,
  dialect: "sqlite" | "pg",
): Promise<SearchFacets> {
  const aggregate = async (col: AnyColumn): Promise<FacetBucket[]> => {
    const valueExpr = sql<string>`lower(${col})`;
    const facetWhere = where
      ? sql`${where} AND ${col} IS NOT NULL AND ${col} <> ''`
      : sql`${col} IS NOT NULL AND ${col} <> ''`;

    if (dialect === "sqlite" && conn.dialect === "sqlite") {
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

    if (conn.dialect === "postgresql") {
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
    }

    throw new Error("runFacets: dialect/connection mismatch");
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
