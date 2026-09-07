// packages/core/src/search/hybrid.ts
//
// The fusion engine (v2.0 Phase 4).
//
// Shape of a keyword/hybrid request:
//
//   1. Structured filters (company, role, seniority, min score, activity…)
//      are compiled once, WITHOUT the free-text terms, and applied inside
//      every arm. Filters are constraints; the free text is what gets ranked.
//   2. Each arm returns a ranked id list, capped at HYBRID_POOL_LIMIT.
//      The portable substring arm always participates — that is the guarantee
//      that hybrid never returns *less* than v1 would have, even with a stale
//      or empty index.
//   3. RRF fuses the lists into one ordered candidate set.
//   4. The page, the total, and the facets are all derived from that set, so
//      what the sidebar counts is what the list can show.
//
// `sort` is preserved: `relevance` pages the fused order directly, any other
// sort uses the fused set as a filter and orders in SQL exactly as the
// portable engine does. Pagination stays coherent because RRF's tie-breaking
// is fully deterministic.
import { sql, type SQL } from "drizzle-orm";
import {
  HYBRID_POOL_LIMIT,
  type SearchArmReport,
  type SearchContactsOptions,
  type SearchContactsResponse,
  type SearchEngineReport,
  type SearchMode,
} from "./types";
import { buildSearchConditions, buildOrderBy, type PreparedTermFilters } from "./conditions";
import {
  EMPTY_FACETS,
  contactColumns,
  idInList,
  mapRow,
  runFacets,
  runRows,
  type Conn,
  type PageRow,
} from "./fetch";
import { keywordArm, semanticArm } from "./arms";
import { reciprocalRankFusion, type RankedList } from "./rrf";
import type { EmbeddingProvider } from "./embeddings";

export interface HybridSearchDeps {
  /**
   * Embedding provider for the semantic arm. `null`/absent = no semantic arm.
   * Injected rather than resolved here so tests never touch the environment
   * and the web/CLI surfaces stay in charge of credential handling.
   */
  embedder?: EmbeddingProvider | null;
  signal?: AbortSignal;
}

interface NormalizedOptions {
  sort: SearchContactsOptions["sort"];
  limit: number;
  offset: number;
  terms: string[];
  cutoff: string | null;
  mode: SearchMode;
}

/**
 * Arm weights.
 *
 * The keyword arm leads: it is the one that actually understands token
 * boundaries and prefixes. Semantic is close behind (it finds the
 * "growth marketing" ↔ "demand gen" matches nothing else can). The portable
 * substring arm is a safety net, not a ranker — it is weighted lowest so a
 * coincidental substring hit inside a notes blob cannot outrank a real
 * full-text match, while still guaranteeing the result appears at all.
 */
export const ARM_WEIGHTS = { keyword: 1, semantic: 0.9, portable: 0.5 } as const;

export async function searchContactsFused(
  conn: Conn,
  options: SearchContactsOptions,
  norm: NormalizedOptions,
  deps: HybridSearchDeps = {},
): Promise<SearchContactsResponse> {
  const cols = contactColumns(conn);

  // Filters only — the free text is ranked by the arms, not filtered in SQL.
  const noTerms: PreparedTermFilters = {
    terms: [],
    cutoff: norm.cutoff,
    fullQuery: null,
  };
  const filters = buildSearchConditions(cols, options, noTerms);
  const query = norm.terms.join(" ");

  // Portable arm: the v1 engine's own ordering, ids only.
  const portableTerms: PreparedTermFilters = {
    terms: norm.terms,
    cutoff: norm.cutoff,
    fullQuery: query.toLowerCase(),
  };
  const portableWhere = buildSearchConditions(cols, options, portableTerms);
  const portableRows = await runRows(
    conn,
    portableWhere,
    buildOrderBy(cols, "relevance", portableTerms.fullQuery),
    HYBRID_POOL_LIMIT,
    0,
  );
  const portable: { ids: string[]; report: SearchArmReport } = {
    ids: portableRows.map((r) => r.id),
    report: { used: true, hits: portableRows.length },
  };

  const keyword = await keywordArm(conn, norm.terms, filters, HYBRID_POOL_LIMIT);
  const semantic =
    norm.mode === "hybrid"
      ? await semanticArm(
          conn,
          query,
          deps.embedder ?? null,
          filters,
          HYBRID_POOL_LIMIT,
          deps.signal,
        )
      : { ids: [], report: { used: false, hits: 0, reason: "not_requested" as const } };

  // An empty index is a distinct, actionable state ("run netpro reindex") —
  // report it rather than the generic zero-hits.
  if (keyword.report.used && keyword.report.hits === 0) {
    const indexed = await countIndexRows(conn);
    if (indexed === 0) {
      keyword.report = { used: false, hits: 0, reason: "index_empty" };
    }
  }

  const lists: RankedList[] = [];
  if (keyword.report.used && keyword.ids.length > 0) {
    lists.push({ arm: "keyword", ids: keyword.ids, weight: ARM_WEIGHTS.keyword });
  }
  if (semantic.report.used && semantic.ids.length > 0) {
    lists.push({ arm: "semantic", ids: semantic.ids, weight: ARM_WEIGHTS.semantic });
  }
  lists.push({ arm: "portable", ids: portable.ids, weight: ARM_WEIGHTS.portable });

  const fused = reciprocalRankFusion(lists);
  const fusedIds = fused.map((f) => f.id).slice(0, HYBRID_POOL_LIMIT);

  const servedMode: SearchMode = keyword.report.used
    ? semantic.report.used
      ? "hybrid"
      : "keyword"
    : semantic.report.used
      ? "hybrid"
      : "portable";

  const engine: SearchEngineReport = {
    mode: servedMode,
    requested: norm.mode,
    arms: { portable: portable.report, keyword: keyword.report, semantic: semantic.report },
    truncated:
      fused.length >= HYBRID_POOL_LIMIT ||
      portable.ids.length >= HYBRID_POOL_LIMIT ||
      keyword.ids.length >= HYBRID_POOL_LIMIT,
  };

  if (fusedIds.length === 0) {
    return {
      contacts: [],
      total: 0,
      limit: norm.limit,
      offset: norm.offset,
      facets: EMPTY_FACETS,
      engine,
    };
  }

  const scopeWhere: SQL = filters
    ? sql`${filters} AND ${idInList(cols, conn, fusedIds)}`
    : idInList(cols, conn, fusedIds);

  let rows: PageRow[];
  if ((norm.sort ?? "relevance") === "relevance") {
    // Page the fused order itself, then fetch just that slice and restore the
    // order in JS (SQL has no portable "order by this id list").
    const pageIds = fusedIds.slice(norm.offset, norm.offset + norm.limit);
    if (pageIds.length === 0) {
      rows = [];
    } else {
      const pageWhere: SQL = filters
        ? sql`${filters} AND ${idInList(cols, conn, pageIds)}`
        : idInList(cols, conn, pageIds);
      const unordered = await runRows(conn, pageWhere, [sql`${cols.fullName} ASC`], pageIds.length, 0);
      const byId = new Map(unordered.map((r) => [r.id, r]));
      rows = pageIds
        .map((id) => byId.get(id))
        .filter((r): r is PageRow => r !== undefined);
    }
  } else {
    rows = await runRows(
      conn,
      scopeWhere,
      buildOrderBy(cols, norm.sort ?? "relevance", null),
      norm.limit,
      norm.offset,
    );
  }

  const facets = await runFacets(conn, cols, scopeWhere);

  return {
    contacts: rows.map(mapRow),
    total: fusedIds.length,
    limit: norm.limit,
    offset: norm.offset,
    facets,
    engine,
  };
}

async function countIndexRows(conn: Conn): Promise<number> {
  try {
    const { rawAll } = await import("./indexer");
    const rows = await rawAll<{ n: number }>(
      conn,
      sql`SELECT count(*) AS n FROM search_index`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
