// packages/core/src/search/arms.ts
//
// The two dialect-native retrieval arms of hybrid search.
//
//   keyword  — SQLite FTS5 (`contacts_fts`, bm25) / Postgres `tsvector`
//              (`search_index.search_vector`, ts_rank). Both read the
//              denormalized document written by indexer.ts, so a contact is
//              only full-text findable once it has been indexed.
//   semantic — cosine similarity over the vectors stored beside that
//              document. Brute-forced in JS: portable across dialects, no
//              pgvector dependency, bounded by SEMANTIC_SCAN_LIMIT.
//
// Both arms return *ranked ids only*. Scores never leave this module — RRF
// fuses on rank, and mixing raw bm25 with cosine would be meaningless anyway.
// Both arms are also failure-tolerant by contract: they report why they
// produced nothing instead of throwing into the request.
import { sql, type SQL } from "drizzle-orm";
import {
  SEMANTIC_SCAN_LIMIT,
  type SearchArmReport,
} from "./types";
import { rawAll } from "./indexer";
import type { Conn } from "./fetch";
import {
  cosineSimilarity,
  decodeEmbedding,
  type EmbeddingProvider,
  EmbeddingsError,
} from "./embeddings";

export interface ArmResult {
  ids: string[];
  report: SearchArmReport;
}

function skipped(
  reason: SearchArmReport["reason"],
  detail?: string,
): ArmResult {
  return { ids: [], report: { used: false, hits: 0, reason, ...(detail ? { detail } : {}) } };
}

// ── Query-string builders (pure, unit-tested) ────────────────────────────

/**
 * Build an FTS5 MATCH expression.
 *
 * Every term is wrapped in double quotes — FTS5 treats bare `AND`, `OR`,
 * `NOT`, `NEAR`, `*`, `:`, `(`, `-` and `^` as operators, so an unquoted user
 * string is both a syntax-error risk and a query-injection surface. Embedded
 * quotes are doubled (FTS5's escape). A trailing `*` outside the quotes gives
 * prefix matching, which is what makes "ste" find "Stephanie" — the single
 * biggest practical win over the substring engine's `LIKE '%ste%'` for
 * left-anchored terms, at index speed.
 *
 * Terms with no indexable characters are dropped; if that leaves nothing, the
 * caller gets null and skips the arm rather than issuing `MATCH ''` (a syntax
 * error in FTS5).
 */
export function buildFts5Query(terms: string[]): string | null {
  const parts = terms
    .map((t) => t.replace(/["\u2018\u2019\u201c\u201d]/g, '"').trim())
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t}"*`);
  return parts.length === 0 ? null : parts.join(" AND ");
}

/**
 * Build a Postgres `to_tsquery` expression.
 *
 * `to_tsquery` (not `plainto_tsquery`) because prefix matching needs the
 * explicit `:*` operator. That means we own the sanitisation: strip everything
 * that is not a letter, digit, or intra-word `-`/`.`/`_`/`@`/`+`, then join
 * with `&`. Anything left is a literal lexeme, so no user input can reach the
 * tsquery grammar.
 */
export function buildTsQuery(terms: string[]): string | null {
  const parts = terms
    .map((t) => t.replace(/[^\p{L}\p{N}\-._@+]/gu, " ").trim())
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `${t}:*`);
  return parts.length === 0 ? null : parts.join(" & ");
}

// ── Keyword arm ──────────────────────────────────────────────────────────

export async function keywordArm(
  conn: Conn,
  terms: string[],
  filters: SQL | undefined,
  limit: number,
): Promise<ArmResult> {
  const filterClause = filters ? sql` AND ${filters}` : sql``;

  try {
    if (conn.dialect === "sqlite") {
      const match = buildFts5Query(terms);
      if (!match) return skipped("not_requested", "No indexable terms in the query.");
      // bm25() is *ascending* (more negative = better), unlike ts_rank.
      const rows = await rawAll<{ id: string }>(
        conn,
        sql`SELECT contacts_fts.contact_id AS id
            FROM contacts_fts
            JOIN contacts ON contacts.id = contacts_fts.contact_id
            WHERE contacts_fts MATCH ${match}${filterClause}
            ORDER BY bm25(contacts_fts) ASC
            LIMIT ${limit}`,
      );
      return finish(rows);
    }

    const tsquery = buildTsQuery(terms);
    if (!tsquery) return skipped("not_requested", "No indexable terms in the query.");
    const rows = await rawAll<{ id: string }>(
      conn,
      sql`SELECT search_index.contact_id AS id
          FROM search_index
          JOIN contacts ON contacts.id = search_index.contact_id
          WHERE search_index.search_vector @@ to_tsquery('english', ${tsquery})${filterClause}
          ORDER BY ts_rank(search_index.search_vector, to_tsquery('english', ${tsquery})) DESC
          LIMIT ${limit}`,
    );
    return finish(rows);
  } catch (error) {
    // Missing table/column = migration 0004 not applied on this database.
    // Everything else is reported the same way: the arm is dropped, the
    // request still succeeds with the remaining arms.
    const message = (error as Error).message ?? "";
    const missing = /no such table|no such column|does not exist|undefined_table|undefined_column/i.test(
      message,
    );
    return skipped(missing ? "index_missing" : "provider_error", truncate(message));
  }
}

function finish(rows: Array<{ id: string }>): ArmResult {
  const ids = rows.map((r) => r.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    return { ids, report: { used: true, hits: 0 } };
  }
  return { ids, report: { used: true, hits: ids.length } };
}

// ── Semantic arm ─────────────────────────────────────────────────────────

interface VectorRow extends Record<string, unknown> {
  contact_id: string;
  embedding: string | null;
  embedding_model: string | null;
}

export async function semanticArm(
  conn: Conn,
  query: string,
  embedder: EmbeddingProvider | null,
  filters: SQL | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<ArmResult> {
  if (!embedder) return skipped("not_configured");

  const filterClause = filters ? sql` AND ${filters}` : sql``;

  let rows: VectorRow[];
  try {
    rows = await rawAll<VectorRow>(
      conn,
      sql`SELECT search_index.contact_id AS contact_id,
                 search_index.embedding AS embedding,
                 search_index.embedding_model AS embedding_model
          FROM search_index
          JOIN contacts ON contacts.id = search_index.contact_id
          WHERE search_index.embedding IS NOT NULL
            AND search_index.embedding_model = ${embedder.model}${filterClause}
          ORDER BY contacts.relationship_score DESC
          LIMIT ${SEMANTIC_SCAN_LIMIT}`,
    );
  } catch (error) {
    return skipped("index_missing", truncate((error as Error).message ?? ""));
  }

  if (rows.length === 0) {
    // Either nothing is embedded, or everything was embedded with a different
    // model. Both mean "reindex with embeddings", so they share a reason.
    return skipped("no_embeddings");
  }

  let queryVector: number[];
  try {
    const [vector] = await embedder.embed([query], signal);
    if (!vector) return skipped("provider_error", "Provider returned no query vector.");
    queryVector = vector;
  } catch (error) {
    const reason =
      error instanceof EmbeddingsError ? error.reason : "provider_error";
    return skipped(reason, truncate((error as Error).message ?? ""));
  }

  const scored: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    const vector = decodeEmbedding(row.embedding);
    // A dimension mismatch scores 0 and drops out below rather than throwing:
    // one bad row must not take the whole arm down.
    if (!vector || vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score > 0) scored.push({ id: row.contact_id, score });
  }

  if (scored.length === 0) return skipped("no_embeddings");

  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  const ids = scored.slice(0, limit).map((s) => s.id);
  return { ids, report: { used: true, hits: ids.length } };
}

function truncate(message: string): string {
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}
