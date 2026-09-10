// packages/core/src/search/query.ts
//
// Faceted people search over the contacts table — the single entry point both
// surfaces call.
//
// `mode: 'portable'` (the default) is the v1 engine: case-insensitive
// substring matching, exact seniority/score/activity filters, facets, and
// pagination, all in ANSI SQL that runs identically on SQLite and Postgres.
// It is untouched by v2.0 Phase 4 — no configuration, no index, no behaviour
// change.
//
// `mode: 'keyword' | 'hybrid'` opt into the blueprint's hybrid engine: the
// dialect-native full-text arm (SQLite FTS5 / Postgres tsvector) and, when
// embeddings are configured, a semantic arm, fused with Reciprocal Rank
// Fusion. That path lives in hybrid.ts; everything the two engines share
// (rows, facets, ordering) lives in fetch.ts.
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  normalizeSearchOptions,
  portableEngineReport,
  type SearchContactsOptions,
  type SearchContactsResponse,
} from "./types";
import {
  buildSearchConditions,
  buildOrderBy,
  type PreparedTermFilters,
} from "./conditions";
import { contactColumns, mapRow, runFacets, runPage } from "./fetch";
import { searchContactsFused, type HybridSearchDeps } from "./hybrid";
import { resolveCommunityMembers } from "../graph/communities";
import type { WorkspaceScope } from "../workspaces/scope";

export async function searchContacts(
  conn: SqliteConn | PgConn,
  options: SearchContactsOptions = {},
  deps: HybridSearchDeps = {},
  scope?: WorkspaceScope,
): Promise<SearchContactsResponse> {
  const norm = normalizeSearchOptions(options);

  // Phase 12 — the community filter is graph-native: resolve the Louvain
  // membership once, then intersect it as an id set. Both engines (and the
  // keyword/semantic arms' filter fragments, the facets, and the totals) read
  // the same `contactIds`, so portable/keyword/hybrid can never disagree on
  // who belongs. An unknown community resolves to the empty set — and an
  // empty set matches nothing, by construction in buildSearchConditions.
  let effective = options;
  const communitySelector = options.community?.trim();
  if (communitySelector) {
    const resolved = await resolveCommunityMembers(conn, communitySelector, {
      scope,
    });
    const members = resolved?.memberIds ?? [];
    effective = {
      ...options,
      contactIds:
        options.contactIds === undefined
          ? members
          : options.contactIds.filter((id) => members.includes(id)),
    };
  }

  // With no free text there is nothing for the ranking arms to rank — the
  // portable engine's filter+sort behaviour is already the correct answer, so
  // a mode request degrades silently rather than paying for an empty fusion.
  if (norm.mode !== "portable" && norm.terms.length > 0) {
    return searchContactsFused(conn, effective, norm, deps, scope);
  }

  const prepared: PreparedTermFilters = {
    terms: norm.terms,
    cutoff: norm.cutoff,
    fullQuery:
      norm.terms.length > 0 ? norm.terms.join(" ").toLowerCase() : null,
  };

  const cols = contactColumns(conn);
  const where = buildSearchConditions(cols, effective, prepared, scope);
  const orderBy = buildOrderBy(cols, norm.sort, prepared.fullQuery);

  const { rows, total } = await runPage(
    conn,
    where,
    orderBy,
    norm.limit,
    norm.offset,
  );
  const facets = await runFacets(conn, cols, where);

  return {
    contacts: rows.map(mapRow),
    total,
    limit: norm.limit,
    offset: norm.offset,
    facets,
    engine: portableEngineReport(norm.mode),
  };
}
