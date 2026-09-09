// packages/core/src/search/indexer.ts
//
// The `search_index` producer (v2.0 Phase 4).
//
// `search_index` has existed since the v0.1 scaffold with no writer, which is
// why the blueprint's FTS/vector engine had nothing to read. This module is
// that writer: one denormalized document per live contact, plus the optional
// embedding for the semantic arm.
//
// Design notes:
//   * **Content-hash guarded.** A reindex recomputes the document, compares a
//     hash, and skips unchanged rows. That makes `netpro reindex` cheap to run
//     on every import and — the load-bearing part — means an unchanged contact
//     never re-pays for an embedding API call.
//   * **Keyword-only by default.** Embeddings are produced only when a caller
//     passes a provider. Import stays fully offline.
//   * **Dialect-portable.** The SQLite FTS5 mirror is maintained by triggers
//     installed in migration 0004, so this module writes one table on both
//     dialects and the Postgres `tsvector` is a generated column. No
//     dialect branch in the producer at all beyond raw-SQL execution.
//   * **Soft deletes are removals.** A soft-deleted contact's row is deleted,
//     which fires the FTS delete trigger — a deleted person must not remain
//     findable.
import { sql, type SQL } from "drizzle-orm";
import type { Conn } from "./fetch";
import {
  EMBEDDING_BATCH_SIZE,
  EmbeddingsError,
  encodeEmbedding,
  type EmbeddingProvider,
} from "./embeddings";
import {
  resolveScope,
  workspaceSql,
  type WorkspaceScope,
} from "../workspaces/scope";

/** Fields folded into the indexed document, in descending signal order. */
export interface IndexableContact {
  id: string;
  fullName: string;
  email?: string | null;
  headline?: string | null;
  company?: string | null;
  role?: string | null;
  seniority?: string | null;
  department?: string | null;
  industry?: string | null;
  location?: string | null;
  country?: string | null;
  notes?: string | null;
  tags?: unknown;
  /** Derived skills verdict (v2.0 Phase 5) — JSON array or JSON string. */
  skills?: unknown;
}

export interface SearchDocument {
  contactId: string;
  searchText: string;
  companyNorm: string | null;
  roleNorm: string | null;
  locationNorm: string | null;
  seniorityNorm: string | null;
  industryNorm: string | null;
  contentHash: string;
}

/** Cap on one indexed document — a pathological `notes` blob must not bloat the index. */
export const MAX_SEARCH_TEXT_CHARS = 4000;

function norm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/** Tags may be a JSON array, a JSON string, or already-parsed — accept all three. */
function tagWords(tags: unknown): string[] {
  if (!tags) return [];
  let value = tags;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [trimmed];
    }
  }
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
  }
  return [];
}

/**
 * Build the indexed document for a contact.
 *
 * The text is lowercased and deduplicated word-wise-free (duplicates are kept:
 * FTS ranking legitimately rewards a term appearing in both `company` and
 * `headline`). It is NOT the display record — it exists purely to be matched.
 */
export function buildSearchDocument(contact: IndexableContact): SearchDocument {
  const parts = [
    contact.fullName,
    contact.email,
    contact.headline,
    contact.company,
    contact.role,
    contact.seniority,
    contact.department,
    contact.industry,
    contact.location,
    contact.country,
    ...tagWords(contact.tags),
    // Skills go in after tags: an explicit verdict outranks a notes mention,
    // and a contact whose only "kubernetes" signal is the derived verdict is
    // exactly the one a keyword search should still find.
    ...tagWords(contact.skills),
    contact.notes,
  ];

  const searchText = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, MAX_SEARCH_TEXT_CHARS);

  return {
    contactId: contact.id,
    searchText,
    companyNorm: norm(contact.company),
    roleNorm: norm(contact.role),
    locationNorm: norm(contact.location),
    seniorityNorm: norm(contact.seniority),
    industryNorm: norm(contact.industry),
    contentHash: hashContent(searchText),
  };
}

/**
 * FNV-1a (64-bit, as two interleaved 32-bit lanes rendered hex).
 *
 * Deliberately not `node:crypto` — this hash is a change detector, not a
 * security primitive, and keeping it pure keeps the module importable from
 * every runtime the app targets without a node-builtin dependency.
 */
export function hashContent(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

// ── Raw execution helpers (one place, both dialects) ─────────────────────

export async function rawAll<T extends Record<string, unknown>>(
  conn: Conn,
  query: SQL,
): Promise<T[]> {
  if (conn.dialect === "sqlite") return conn.db.all<T>(query);
  const result = await conn.db.execute<T>(query);
  return result.rows as T[];
}

export async function rawRun(conn: Conn, query: SQL): Promise<void> {
  if (conn.dialect === "sqlite") {
    conn.db.run(query);
    return;
  }
  await conn.db.execute(query);
}

// ── Reindex ──────────────────────────────────────────────────────────────

export interface ReindexOptions {
  /** Restrict the run to these contacts (import passes just what it touched). */
  contactIds?: string[];
  /** Supply a provider to (re)compute embeddings. Omit for a keyword-only run. */
  embedder?: EmbeddingProvider | null;
  /** Re-write every row even when the content hash is unchanged. */
  force?: boolean;
  /** Cap on contacts processed in one run; protects an accidental full rebuild. */
  limit?: number;
  signal?: AbortSignal;
}

export interface ReindexSummary {
  /** Live contacts examined. */
  scanned: number;
  /** Rows written (inserted or updated). */
  indexed: number;
  /** Rows skipped because the content hash matched. */
  skipped: number;
  /** Index rows deleted (contact soft-deleted or gone). */
  pruned: number;
  /** Vectors written. */
  embedded: number;
  /** Non-fatal embedding failure, if any — the keyword index still updated. */
  embeddingError: string | null;
}

interface ContactRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  email: string | null;
  headline: string | null;
  company: string | null;
  role: string | null;
  seniority: string | null;
  department: string | null;
  industry: string | null;
  location: string | null;
  country: string | null;
  notes: string | null;
  tags: unknown;
  skills: unknown;
}

interface IndexRow extends Record<string, unknown> {
  contact_id: string;
  content_hash: string | null;
  embedding_model: string | null;
  embedding: string | null;
}

/**
 * Rebuild `search_index` for live contacts.
 *
 * Returns a summary rather than throwing on embedding failure: a provider
 * outage must degrade the semantic arm, never block the keyword index that
 * needs no network at all.
 */
export async function reindexSearchIndex(
  conn: Conn,
  options: ReindexOptions = {},
  scope?: WorkspaceScope,
): Promise<ReindexSummary> {
  const resolved = resolveScope(scope);
  const ids = options.contactIds?.filter(
    (id) => typeof id === "string" && id !== "",
  );
  if (options.contactIds && (!ids || ids.length === 0)) {
    return emptySummary();
  }

  const idScope = ids
    ? sql` AND id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const limitClause = options.limit
    ? sql` LIMIT ${Math.max(1, Math.floor(options.limit))}`
    : sql``;

  // v3.0 Phase 2 — a reindex only ever scans one workspace's contacts, so
  // its writes and prunes are per-workspace by construction.
  const contacts = await rawAll<ContactRow>(
    conn,
    sql`SELECT id, full_name, email, headline, company, role, seniority, department,
               industry, location, country, notes, tags, skills
        FROM contacts
        WHERE deleted_at IS NULL AND ${workspaceSql(scope, "contacts.workspace_id")}${idScope}
        ORDER BY id${limitClause}`,
  );

  // Prune index rows whose contact is gone or soft-deleted. Scoped the same
  // way, so a targeted reindex cannot wipe unrelated rows — and a scoped
  // reindex can never prune another workspace's rows.
  const pruneScope = ids
    ? sql` AND contact_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const stale = await rawAll<{ contact_id: string }>(
    conn,
    sql`SELECT contact_id FROM search_index
        WHERE ${workspaceSql(scope, "search_index.workspace_id")}
          AND contact_id NOT IN (SELECT id FROM contacts WHERE deleted_at IS NULL)${pruneScope}`,
  );
  for (const row of stale) {
    await rawRun(
      conn,
      sql`DELETE FROM search_index WHERE contact_id = ${row.contact_id} AND ${workspaceSql(scope, "search_index.workspace_id")}`,
    );
  }

  const summary: ReindexSummary = { ...emptySummary(), pruned: stale.length };
  if (contacts.length === 0) return summary;

  const existing = new Map<string, IndexRow>();
  const existingRows = await rawAll<IndexRow>(
    conn,
    sql`SELECT contact_id, content_hash, embedding_model, embedding FROM search_index
        WHERE ${workspaceSql(scope, "search_index.workspace_id")}${
          ids
            ? sql` AND contact_id IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : sql``
        }`,
  );
  for (const row of existingRows) existing.set(row.contact_id, row);

  const model = options.embedder?.model ?? null;
  const pending: Array<{ doc: SearchDocument; needsEmbedding: boolean }> = [];

  for (const row of contacts) {
    summary.scanned += 1;
    const doc = buildSearchDocument({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      headline: row.headline,
      company: row.company,
      role: row.role,
      seniority: row.seniority,
      department: row.department,
      industry: row.industry,
      location: row.location,
      country: row.country,
      notes: row.notes,
      tags: row.tags,
      skills: row.skills,
    });

    const prior = existing.get(row.id);
    const textUnchanged =
      !options.force && prior?.content_hash === doc.contentHash;
    // A vector is stale when the text changed, the model changed, or there
    // simply isn't one yet. Model changes matter: vectors from two models are
    // not comparable and must never be ranked against each other.
    const needsEmbedding = Boolean(
      model &&
      (options.force ||
        !textUnchanged ||
        !prior?.embedding ||
        prior.embedding_model !== model),
    );

    if (textUnchanged && !needsEmbedding) {
      summary.skipped += 1;
      continue;
    }
    pending.push({ doc, needsEmbedding });
  }

  // Embed in batches; one failed batch disables embedding for the rest of the
  // run but still writes every keyword document.
  const vectors = new Map<string, number[]>();
  if (options.embedder) {
    const toEmbed = pending.filter((p) => p.needsEmbedding);
    for (let i = 0; i < toEmbed.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
      try {
        const result = await options.embedder.embed(
          batch.map((p) => p.doc.searchText),
          options.signal,
        );
        batch.forEach((p, j) => {
          const vector = result[j];
          if (vector) vectors.set(p.doc.contactId, vector);
        });
      } catch (error) {
        summary.embeddingError =
          error instanceof EmbeddingsError
            ? error.message
            : `Embeddings failed: ${(error as Error).message}`;
        break;
      }
    }
  }

  const now = new Date().toISOString();
  for (const { doc } of pending) {
    const vector = vectors.get(doc.contactId);
    const encoded = vector ? encodeEmbedding(vector) : null;
    await upsertDocument(conn, doc, {
      now,
      embedding: encoded,
      embeddingModel: encoded ? model : null,
      embeddingDim: vector ? vector.length : null,
      keepExistingEmbedding: !encoded,
      workspaceId: resolved.workspaceId,
    });
    summary.indexed += 1;
    if (encoded) summary.embedded += 1;
  }

  return summary;
}

interface UpsertVectorFields {
  now: string;
  embedding: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  /** Preserve any vector already stored (keyword-only runs must not erase it). */
  keepExistingEmbedding: boolean;
  /** Tenancy stamp (v3.0 Phase 2). */
  workspaceId: string;
}

async function upsertDocument(
  conn: Conn,
  doc: SearchDocument,
  v: UpsertVectorFields,
): Promise<void> {
  // `ON CONFLICT (...) DO UPDATE` is supported identically by SQLite ≥3.24 and
  // Postgres, so the producer needs no dialect branch. `excluded.*` likewise.
  const embeddingSet = v.keepExistingEmbedding
    ? sql`embedding = search_index.embedding,
          embedding_model = search_index.embedding_model,
          embedding_dim = search_index.embedding_dim,
          embedding_updated_at = search_index.embedding_updated_at`
    : sql`embedding = excluded.embedding,
          embedding_model = excluded.embedding_model,
          embedding_dim = excluded.embedding_dim,
          embedding_updated_at = excluded.embedding_updated_at`;

  await rawRun(
    conn,
    sql`INSERT INTO search_index (
          contact_id, workspace_id, search_text, company_norm, role_norm, location_norm,
          seniority_norm, industry_norm, embedding, embedding_model,
          embedding_dim, embedding_updated_at, content_hash, updated_at
        ) VALUES (
          ${doc.contactId}, ${v.workspaceId}, ${doc.searchText}, ${doc.companyNorm}, ${doc.roleNorm},
          ${doc.locationNorm}, ${doc.seniorityNorm}, ${doc.industryNorm},
          ${v.embedding}, ${v.embeddingModel}, ${v.embeddingDim},
          ${v.embedding ? v.now : null}, ${doc.contentHash}, ${v.now}
        )
        ON CONFLICT (contact_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          search_text = excluded.search_text,
          company_norm = excluded.company_norm,
          role_norm = excluded.role_norm,
          location_norm = excluded.location_norm,
          seniority_norm = excluded.seniority_norm,
          industry_norm = excluded.industry_norm,
          ${embeddingSet},
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`,
  );
}

function emptySummary(): ReindexSummary {
  return {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    pruned: 0,
    embedded: 0,
    embeddingError: null,
  };
}

// ── Status ───────────────────────────────────────────────────────────────

export interface SearchIndexStatus {
  /** Live contacts. */
  contacts: number;
  /** Contacts with an index row. */
  indexed: number;
  /** Index rows carrying a vector. */
  embedded: number;
  /** Distinct embedding models present — more than one means a reindex is due. */
  embeddingModels: string[];
  /** True when the dialect-native full-text index exists (migration 0004 applied). */
  keywordIndexAvailable: boolean;
}

export async function searchIndexStatus(
  conn: Conn,
  scope?: WorkspaceScope,
): Promise<SearchIndexStatus> {
  const [counts] = await rawAll<{
    contacts: number;
    indexed: number;
    embedded: number;
  }>(
    conn,
    sql`SELECT
          (SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND ${workspaceSql(scope, "contacts.workspace_id")}) AS contacts,
          (SELECT count(*) FROM search_index WHERE ${workspaceSql(scope, "search_index.workspace_id")}) AS indexed,
          (SELECT count(*) FROM search_index WHERE embedding IS NOT NULL AND ${workspaceSql(scope, "search_index.workspace_id")}) AS embedded`,
  );

  const models = await rawAll<{ embedding_model: string | null }>(
    conn,
    sql`SELECT DISTINCT embedding_model FROM search_index WHERE embedding_model IS NOT NULL AND ${workspaceSql(scope, "search_index.workspace_id")}`,
  );

  return {
    contacts: Number(counts?.contacts ?? 0),
    indexed: Number(counts?.indexed ?? 0),
    embedded: Number(counts?.embedded ?? 0),
    embeddingModels: models
      .map((m) => m.embedding_model)
      .filter((m): m is string => typeof m === "string")
      .sort(),
    keywordIndexAvailable: await keywordIndexAvailable(conn),
  };
}

/**
 * Does the dialect-native keyword index exist?
 *
 * Cheap and safe on both dialects: SQLite reads `sqlite_master`, Postgres asks
 * the catalog for the generated `search_vector` column. An unmigrated database
 * answers "no" instead of blowing up mid-search.
 */
export async function keywordIndexAvailable(conn: Conn): Promise<boolean> {
  try {
    if (conn.dialect === "sqlite") {
      const rows = await rawAll<{ n: number }>(
        conn,
        sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'contacts_fts'`,
      );
      return Number(rows[0]?.n ?? 0) > 0;
    }
    const rows = await rawAll<{ n: number }>(
      conn,
      sql`SELECT count(*) AS n FROM information_schema.columns
          WHERE table_name = 'search_index' AND column_name = 'search_vector'`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
