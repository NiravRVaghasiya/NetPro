// packages/core/src/content/repository.ts
//
// v2.5 Phase 4 — the database half of the content tracker.
//
// Reads are raw ANSI SQL through the same `rawAll` helper the search indexer
// and the events module use: one query text, both dialects, no per-dialect
// duplication. Writes go through Drizzle inside a dialect branch because the
// `SqliteConn | PgConn` union cannot be narrowed for a typed insert, and
// because JSON columns are JSON-mode on SQLite but plain text on Postgres
// (stringified in code, like `contacts.tags`).
//
// Two invariants the Phase 5 surfaces will depend on:
//
//   * **Idempotent imports.** Re-importing the same CSV or feed adds no rows:
//     items dedupe on `url_norm` (backed by a UNIQUE constraint), metrics are
//     append-only snapshots, mentions dedupe on (content, contact).
//   * **Deletes are explicit.** `deleteContentItem` removes the item's
//     metrics and mentions itself rather than relying on FK enforcement,
//     which SQLite leaves off by default.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { getContactById } from "../ai/resolve-contact";
import { writeActivityLog } from "../crm/activity";
import { rawAll } from "../search/indexer";
import {
  resolveScope,
  workspaceSql,
  type WorkspaceScope,
} from "../workspaces/scope";
import {
  parseContentCsv,
  parseContentDate,
  parseFeedXml,
  splitTagList,
} from "./parse";
import type { ParsedContentRow } from "./parse";
import { detectPlatform, normalizeContentUrl, parsePlatform } from "./urls";
import {
  CONTENT_LIMITS,
  CONTENT_SOURCES,
  CONTENT_TYPES,
  METRIC_SOURCES,
  ContentError,
  resolveNow,
  type ContentItem,
  type ContentItemSummary,
  type ContentMention,
  type ContentMetric,
  type ContentOptions,
  type ContentPlatform,
  type ContentSource,
  type ContentStatus,
  type ContentType,
  type MetricSource,
} from "./types";

type Conn = SqliteConn | PgConn;
type SQL = ReturnType<typeof sql>;

// ── Small shared validation ──────────────────────────────────────────────

function text(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ContentError("invalid_input", `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ContentError(
      "invalid_input",
      `"${field}" must be ${max} characters or fewer.`,
    );
  }
  return trimmed === "" ? null : trimmed;
}

function requiredText(value: unknown, max: number, field: string): string {
  const v = text(value, max, field);
  if (!v) throw new ContentError("invalid_input", `"${field}" is required.`);
  return v;
}

function whitelist<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw new ContentError(
    "invalid_input",
    `Unknown ${field} "${String(value)}". Expected one of: ${allowed.join(", ")}.`,
  );
}

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Escape LIKE wildcards so a search for `100%` is not "anything". */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function likePattern(query: string): string {
  const trimmed = query.trim().slice(0, CONTENT_LIMITS.query).toLowerCase();
  return `%${likeEscape(trimmed)}%`;
}

/** A reported count: a non-negative integer, or null when unreported. */
function metricInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ContentError(
      "invalid_input",
      `"${field}" must be a non-negative integer.`,
    );
  }
  if (value > 2_147_483_647) {
    throw new ContentError("invalid_input", `"${field}" is implausibly large.`);
  }
  return value;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean" && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toTags(value: unknown): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t): t is string => typeof t === "string");
}

function cleanTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return splitTagList(value).tags;
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) {
    throw new ContentError(
      "invalid_input",
      '"tags" must be an array of strings.',
    );
  }
  const { tags, dropped } = splitTagList(value);
  if (dropped > 0) {
    throw new ContentError(
      "invalid_input",
      `"tags" holds at most ${CONTENT_LIMITS.tags} tags (${dropped} too many).`,
    );
  }
  return tags;
}

// ── Row shapes ───────────────────────────────────────────────────────────

interface ItemSqlRow extends Record<string, unknown> {
  id: string;
  url: string;
  url_norm: string;
  title: string;
  platform: string;
  type: string | null;
  published_at: string | null;
  author: string | null;
  tags: unknown;
  summary: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

interface MetricSqlRow extends Record<string, unknown> {
  id: string;
  content_id: string;
  fetched_at: string;
  source: string;
  views: number | string | null;
  likes: number | string | null;
  comments: number | string | null;
  shares: number | string | null;
  bookmarks: number | string | null;
  raw_payload: unknown;
  created_at: string;
}

function toItem(r: ItemSqlRow): ContentItem {
  return {
    id: r.id,
    url: r.url,
    urlNorm: r.url_norm,
    title: r.title,
    platform: r.platform,
    type: r.type,
    publishedAt: r.published_at,
    author: r.author,
    tags: toTags(r.tags),
    summary: r.summary,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMetric(r: MetricSqlRow): ContentMetric {
  const count = (v: number | string | null): number | null =>
    v === null || v === undefined ? null : num(v);
  const payload = parseJson(r.raw_payload);
  return {
    id: r.id,
    contentId: r.content_id,
    fetchedAt: r.fetched_at,
    source: r.source,
    views: count(r.views),
    likes: count(r.likes),
    comments: count(r.comments),
    shares: count(r.shares),
    bookmarks: count(r.bookmarks),
    rawPayload:
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null,
    createdAt: r.created_at,
  };
}

const ITEM_SELECT = sql`SELECT i.id AS id, i.url AS url, i.url_norm AS url_norm,
  i.title AS title, i.platform AS platform, i.type AS type,
  i.published_at AS published_at, i.author AS author, i.tags AS tags,
  i.summary AS summary, i.source AS source,
  i.created_at AS created_at, i.updated_at AS updated_at`;

const METRIC_SELECT = sql`SELECT m.id AS id, m.content_id AS content_id,
  m.fetched_at AS fetched_at, m.source AS source,
  m.views AS views, m.likes AS likes, m.comments AS comments,
  m.shares AS shares, m.bookmarks AS bookmarks,
  m.raw_payload AS raw_payload, m.created_at AS created_at`;

/** Newest snapshot first; ties broken deterministically so both dialects agree. */
const LATEST_ORDER = sql`ORDER BY m.fetched_at DESC, m.created_at DESC, m.id DESC`;

// ── Reads ────────────────────────────────────────────────────────────────

async function itemRowById(
  conn: Conn,
  id: string,
  scope?: WorkspaceScope,
): Promise<ContentItem | null> {
  const rows = await rawAll<ItemSqlRow>(
    conn,
    sql`${ITEM_SELECT} FROM content_items i
        WHERE i.id = ${id} AND ${workspaceSql(scope, "i.workspace_id")}`,
  );
  return rows[0] ? toItem(rows[0]) : null;
}

async function itemRowByUrlNorm(
  conn: Conn,
  urlNorm: string,
  scope?: WorkspaceScope,
): Promise<ContentItem | null> {
  const rows = await rawAll<ItemSqlRow>(
    conn,
    sql`${ITEM_SELECT} FROM content_items i
        WHERE i.url_norm = ${urlNorm} AND ${workspaceSql(scope, "i.workspace_id")}`,
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export interface ListContentOptions {
  platform?: ContentPlatform | string;
  /** Case-insensitive exact tag match. */
  tag?: string;
  /** Only items published within the last N days (undated items excluded). */
  days?: number;
  query?: string;
  limit?: number;
  offset?: number;
  now?: Date;
  /** v3.0 Phase 2 — workspace scope. Absent = bootstrap workspace. */
  scope?: WorkspaceScope;
}

export interface ListContentResult {
  items: ContentItem[];
  total: number;
  limit: number;
  offset: number;
}

function buildItemFilters(
  conn: Conn,
  opts: ListContentOptions,
): { where: SQL } {
  void conn;
  const parts: SQL[] = [workspaceSql(opts.scope, "i.workspace_id")];
  if (
    opts.platform !== undefined &&
    opts.platform !== null &&
    opts.platform !== ""
  ) {
    parts.push(sql`i.platform = ${parsePlatform(String(opts.platform))}`);
  }
  const tag = opts.tag?.trim().toLowerCase();
  if (tag) {
    // Tags are a JSON array in a text column; match one quoted element
    // (`"js"`) through lower() so SQLite's case-insensitive LIKE and
    // Postgres' case-sensitive LIKE answer identically.
    parts.push(
      sql`lower(i.tags) LIKE ${`%"${likeEscape(tag.slice(0, CONTENT_LIMITS.tagLength))}"%`} ESCAPE '\\'`,
    );
  }
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days < 0) {
      throw new ContentError(
        "invalid_input",
        '"days" must be a non-negative number.',
      );
    }
    const cutoff =
      resolveNow(opts).getTime() - Math.floor(opts.days) * 24 * 60 * 60 * 1000;
    parts.push(
      sql`i.published_at IS NOT NULL AND i.published_at >= ${new Date(cutoff).toISOString()}`,
    );
  }
  const q = opts.query?.trim();
  if (q) {
    const pattern = likePattern(q);
    parts.push(
      sql`(lower(i.title) LIKE ${pattern} ESCAPE '\\' OR lower(i.url) LIKE ${pattern} ESCAPE '\\' OR lower(i.author) LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  return {
    where:
      parts.length === 0 ? sql`` : sql` WHERE ${sql.join(parts, sql` AND `)}`,
  };
}

/** Items, newest-published first (undated last), with the total for paging. */
export async function listContentItems(
  conn: Conn,
  opts: ListContentOptions = {},
): Promise<ListContentResult> {
  const limit = clampInt(opts.limit, 50, 1, 200);
  const offset = clampInt(opts.offset, 0, 0, 100_000);
  const { where } = buildItemFilters(conn, opts);

  const rows = await rawAll<ItemSqlRow>(
    conn,
    sql`${ITEM_SELECT} FROM content_items i${where}
        ORDER BY (i.published_at IS NULL), i.published_at DESC, i.title ASC
        LIMIT ${limit} OFFSET ${offset}`,
  );
  const counted = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(*) AS n FROM content_items i${where}`,
  );
  return {
    items: rows.map(toItem),
    total: num(counted[0]?.n ?? 0),
    limit,
    offset,
  };
}

export interface ListContentSummariesResult {
  items: ContentItemSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The list with engagement attached: latest snapshot, snapshot count and
 * live-mention count per row, via three batched `IN` queries (never a
 * per-item round-trip). This is what list pages and the API list answer
 * with — the bare `listContentItems` stays for callers that only need the
 * rows themselves.
 */
export async function listContentSummaries(
  conn: Conn,
  opts: ListContentOptions = {},
): Promise<ListContentSummariesResult> {
  const { items, total, limit, offset } = await listContentItems(conn, opts);
  return {
    items: await enrichSummaries(conn, items, opts.scope),
    total,
    limit,
    offset,
  };
}

/**
 * Attach `latestMetrics`, `metricsCount` and `mentionsCount` to item rows.
 * Three batched queries keyed on the item ids — no per-item round-trips.
 */
async function enrichSummaries(
  conn: Conn,
  items: ContentItem[],
  scope?: WorkspaceScope,
): Promise<ContentItemSummary[]> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  // The latest snapshot per item: the row for which no newer row exists,
  // newest-first on (fetched_at, created_at, id). Row-value comparison is
  // portable across SQLite and Postgres.
  const latestRows = await rawAll<MetricSqlRow>(
    conn,
    sql`${METRIC_SELECT} FROM content_metrics m
        WHERE m.content_id IN (${idList})
          AND (m.fetched_at, m.created_at, m.id) = (
            SELECT n.fetched_at, n.created_at, n.id FROM content_metrics n
            WHERE n.content_id = m.content_id
            ORDER BY n.fetched_at DESC, n.created_at DESC, n.id DESC
            LIMIT 1
          )`,
  );
  const metricCounts = await rawAll<{ content_id: string; n: number | string }>(
    conn,
    sql`SELECT content_id, COUNT(*) AS n FROM content_metrics m
        WHERE m.content_id IN (${idList}) GROUP BY content_id`,
  );
  const mentionCounts = await rawAll<{
    content_id: string;
    n: number | string;
  }>(
    conn,
    sql`SELECT m.content_id AS content_id, COUNT(*) AS n FROM content_mentions m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.content_id IN (${idList}) AND c.deleted_at IS NULL
          AND ${workspaceSql(scope, "c.workspace_id")}
        GROUP BY m.content_id`,
  );

  const latestById = new Map<string, ContentMetric>();
  for (const r of latestRows) latestById.set(r.content_id, toMetric(r));
  const metricsById = new Map<string, number>();
  for (const r of metricCounts) metricsById.set(r.content_id, num(r.n));
  const mentionsById = new Map<string, number>();
  for (const r of mentionCounts) mentionsById.set(r.content_id, num(r.n));

  return items.map((item) => ({
    ...item,
    latestMetrics: latestById.get(item.id) ?? null,
    metricsCount: metricsById.get(item.id) ?? 0,
    mentionsCount: mentionsById.get(item.id) ?? 0,
  }));
}

/**
 * Resolve an id or an exact URL to one item. URLs normalize first, so a link
 * pasted with `?utm_source=…` still finds its row. Ambiguity is impossible
 * (`url_norm` is UNIQUE) — the miss is always `not_found`.
 */
export async function resolveContentRef(
  conn: Conn,
  selector: string,
  scope?: WorkspaceScope,
): Promise<ContentItem> {
  const trimmed = selector.trim();
  if (!trimmed)
    throw new ContentError("invalid_input", "A content id or URL is required.");
  const byId = await itemRowById(conn, trimmed, scope);
  if (byId) return byId;
  let urlNorm: string | null = null;
  try {
    urlNorm = normalizeContentUrl(trimmed);
  } catch {
    // Not a URL — the id lookup above already missed, so this is a miss.
  }
  if (urlNorm) {
    const byUrl = await itemRowByUrlNorm(conn, urlNorm, scope);
    if (byUrl) return byUrl;
  }
  throw new ContentError(
    "not_found",
    `No content found with id or URL "${trimmed.slice(0, 120)}".`,
  );
}

async function latestMetric(
  conn: Conn,
  contentId: string,
  scope?: WorkspaceScope,
): Promise<ContentMetric | null> {
  const rows = await rawAll<MetricSqlRow>(
    conn,
    sql`${METRIC_SELECT} FROM content_metrics m
        WHERE m.content_id = ${contentId} AND ${workspaceSql(scope, "m.workspace_id")}
        ${LATEST_ORDER} LIMIT 1`,
  );
  return rows[0] ? toMetric(rows[0]) : null;
}

async function countMetrics(
  conn: Conn,
  contentId: string,
  scope?: WorkspaceScope,
): Promise<number> {
  const rows = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(*) AS n FROM content_metrics m
        WHERE m.content_id = ${contentId} AND ${workspaceSql(scope, "m.workspace_id")}`,
  );
  return num(rows[0]?.n ?? 0);
}

async function countLiveMentions(
  conn: Conn,
  contentId: string,
  scope?: WorkspaceScope,
): Promise<number> {
  const rows = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(*) AS n FROM content_mentions m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.content_id = ${contentId} AND c.deleted_at IS NULL
          AND ${workspaceSql(scope, "c.workspace_id")}`,
  );
  return num(rows[0]?.n ?? 0);
}

/** One item with its latest snapshot and live counts — the detail payload. */
export async function getContentItem(
  conn: Conn,
  id: string,
  scope?: WorkspaceScope,
): Promise<ContentItemSummary | null> {
  const item = await itemRowById(conn, id.trim(), scope);
  if (!item) return null;
  const [metrics, metricsCount, mentionsCount] = await Promise.all([
    latestMetric(conn, item.id, scope),
    countMetrics(conn, item.id, scope),
    countLiveMentions(conn, item.id, scope),
  ]);
  return { ...item, latestMetrics: metrics, metricsCount, mentionsCount };
}

// ── Writes: items ────────────────────────────────────────────────────────

export interface AddContentItemInput {
  url: string;
  title: string;
  /** Omitted → detected from the URL's host, else `blog`. */
  platform?: ContentPlatform | string;
  type?: ContentType | string | null;
  publishedAt?: string | null;
  author?: string | null;
  tags?: string[] | string | null;
  summary?: string | null;
  source?: ContentSource | string;
}

export interface UpsertContentItemResult {
  item: ContentItem;
  created: boolean;
}

function coerceItemFields(input: AddContentItemInput): {
  url: string;
  urlNorm: string;
  title: string;
  platform: ContentPlatform;
  type: ContentType | null;
  publishedAt: string | null;
  author: string | null;
  tags: string[];
  summary: string | null;
  source: ContentSource;
} {
  const url = requiredText(input.url, CONTENT_LIMITS.url, "url");
  const urlNorm = normalizeContentUrl(url);
  const title = requiredText(input.title, CONTENT_LIMITS.title, "title");
  const platform =
    input.platform === undefined ||
    input.platform === null ||
    input.platform === ""
      ? (detectPlatform(url) ?? "blog")
      : parsePlatform(String(input.platform));
  let type: ContentType | null = null;
  if (input.type !== undefined && input.type !== null && input.type !== "") {
    if (
      typeof input.type !== "string" ||
      !(CONTENT_TYPES as readonly string[]).includes(input.type)
    ) {
      throw new ContentError(
        "invalid_input",
        `Unknown type "${String(input.type)}". Expected one of: ${CONTENT_TYPES.join(", ")}.`,
      );
    }
    type = input.type as ContentType;
  }
  const publishedRaw = text(input.publishedAt, 64, "publishedAt");
  const publishedAt = parseContentDate(publishedRaw);
  if (publishedRaw !== null && publishedAt === null) {
    throw new ContentError(
      "invalid_input",
      `"${publishedRaw}" is not a date NetPro can read (use YYYY-MM-DD).`,
    );
  }
  return {
    url,
    urlNorm,
    title,
    platform,
    type,
    publishedAt,
    author: text(input.author, CONTENT_LIMITS.author, "author"),
    tags: cleanTags(input.tags),
    summary: text(input.summary, CONTENT_LIMITS.summary, "summary"),
    source: whitelist(input.source, CONTENT_SOURCES, "source", "manual"),
  };
}

/** Create an item, or return the existing one with the same normalized URL. */
export async function upsertContentItem(
  conn: Conn,
  input: AddContentItemInput,
  opts: ContentOptions = {},
): Promise<UpsertContentItemResult> {
  const fields = coerceItemFields(input);
  const resolved = resolveScope(opts.scope);
  const existing = await itemRowByUrlNorm(conn, fields.urlNorm, resolved);
  // Idempotent means unchanged: a re-import reports `existing`, it does not
  // overwrite the title the owner may have edited since.
  if (existing) return { item: existing, created: false };

  const nowIso = resolveNow(opts).toISOString();
  const row = {
    id: randomUUID(),
    workspaceId: resolved.workspaceId,
    ...fields,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  // The UNIQUE constraint on `url_norm` is the backstop for a concurrent
  // double-insert; the pre-check above is what makes the common path clear.
  try {
    if (conn.dialect === "sqlite") {
      await conn.db.insert(conn.schema.contentItems).values(row);
    } else {
      await conn.db
        .insert(conn.schema.contentItems)
        .values({ ...row, tags: JSON.stringify(row.tags) });
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await itemRowByUrlNorm(conn, fields.urlNorm, resolved);
      if (raced) return { item: raced, created: false };
    }
    throw error;
  }
  await writeActivityLog(
    conn,
    {
      action: "content.created",
      entityType: "content",
      entityId: row.id,
      metadata: { url: row.url, platform: row.platform, source: row.source },
    },
    resolved,
  );
  const created = await itemRowById(conn, row.id, resolved);
  return { item: created!, created: true };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") ||
    message.includes("duplicate key value") ||
    (typeof (error as { code?: unknown })?.code === "string" &&
      (error as { code: string }).code === "23505")
  );
}

/** Strict add: a duplicate URL is a `conflict`, not a silent return. */
export async function addContentItem(
  conn: Conn,
  input: AddContentItemInput,
  opts: ContentOptions = {},
): Promise<ContentItem> {
  const fields = coerceItemFields(input);
  const existing = await itemRowByUrlNorm(conn, fields.urlNorm, opts.scope);
  if (existing) {
    throw new ContentError(
      "conflict",
      `This URL is already tracked as "${existing.title}".`,
    );
  }
  const { item } = await upsertContentItem(conn, input, opts);
  return item;
}

/**
 * Delete an item and its metrics + mentions. Children go first, explicitly —
 * portable whether or not the connection enforces foreign keys.
 */
export async function deleteContentItem(
  conn: Conn,
  id: string,
  scope?: WorkspaceScope,
): Promise<ContentItem> {
  const item = await itemRowById(conn, id.trim(), resolveScope(scope));
  if (!item)
    throw new ContentError("not_found", `No content with id "${id.trim()}".`);
  // Every child delete carries the workspace too: a forged id pair must
  // never reach across workspaces even if the item check were bypassed.
  const ws = workspaceSql(scope, "content_mentions.workspace_id");
  const wsM = workspaceSql(scope, "content_metrics.workspace_id");
  if (conn.dialect === "sqlite") {
    await conn.db.run(
      sql`DELETE FROM content_metrics WHERE content_id = ${item.id} AND ${wsM}`,
    );
    await conn.db.run(
      sql`DELETE FROM content_mentions WHERE content_id = ${item.id} AND ${ws}`,
    );
    await conn.db
      .delete(conn.schema.contentItems)
      .where(
        and(
          eq(conn.schema.contentItems.id, item.id),
          workspaceScopeEq(conn, item, scope),
        ),
      );
  } else {
    await conn.db.execute(
      sql`DELETE FROM content_metrics WHERE content_id = ${item.id} AND ${wsM}`,
    );
    await conn.db.execute(
      sql`DELETE FROM content_mentions WHERE content_id = ${item.id} AND ${ws}`,
    );
    await conn.db
      .delete(conn.schema.contentItems)
      .where(
        and(
          eq(conn.schema.contentItems.id, item.id),
          workspaceScopeEq(conn, item, scope),
        ),
      );
  }
  await writeActivityLog(
    conn,
    {
      action: "content.removed",
      entityType: "content",
      entityId: item.id,
    },
    scope,
  );
  return item;
}

/** Drizzle `eq` on the item workspace, for the typed delete path. */
function workspaceScopeEq(
  conn: Conn,
  item: ContentItem,
  scope?: WorkspaceScope,
) {
  return eq(
    conn.schema.contentItems.workspaceId,
    resolveScope(scope).workspaceId,
  );
}

// ── Writes: metrics ──────────────────────────────────────────────────────

export interface RecordMetricsInput {
  contentId: string;
  fetchedAt?: string | null;
  source?: MetricSource | string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  bookmarks?: number | null;
  rawPayload?: Record<string, unknown> | null;
}

/** Append an engagement snapshot. Snapshots are never updated, only added. */
export async function recordMetrics(
  conn: Conn,
  input: RecordMetricsInput,
  opts: ContentOptions = {},
): Promise<ContentMetric> {
  const contentId = input.contentId?.trim() ?? "";
  if (!contentId)
    throw new ContentError("invalid_input", '"contentId" is required.');
  const item = await itemRowById(conn, contentId, opts.scope);
  if (!item)
    throw new ContentError("not_found", `No content with id "${contentId}".`);

  const views = metricInt(input.views, "views");
  const likes = metricInt(input.likes, "likes");
  const comments = metricInt(input.comments, "comments");
  const shares = metricInt(input.shares, "shares");
  const bookmarks = metricInt(input.bookmarks, "bookmarks");
  if (
    views === null &&
    likes === null &&
    comments === null &&
    shares === null &&
    bookmarks === null
  ) {
    throw new ContentError(
      "invalid_input",
      "At least one metric (views, likes, …) is required.",
    );
  }

  const fetchedRaw = text(input.fetchedAt, 64, "fetchedAt");
  const fetchedAt =
    fetchedRaw === null
      ? resolveNow(opts).toISOString()
      : parseContentDate(fetchedRaw);
  if (fetchedAt === null) {
    throw new ContentError(
      "invalid_input",
      `"${fetchedRaw}" is not a date NetPro can read (use YYYY-MM-DD).`,
    );
  }
  const source = whitelist(input.source, METRIC_SOURCES, "source", "manual");

  let rawPayload: Record<string, unknown> | null = null;
  if (input.rawPayload !== undefined && input.rawPayload !== null) {
    if (
      typeof input.rawPayload !== "object" ||
      Array.isArray(input.rawPayload)
    ) {
      throw new ContentError(
        "invalid_input",
        '"rawPayload" must be a JSON object.',
      );
    }
    try {
      JSON.stringify(input.rawPayload);
    } catch {
      throw new ContentError(
        "invalid_input",
        '"rawPayload" must be JSON-serializable.',
      );
    }
    rawPayload = input.rawPayload;
  }

  const row = {
    id: randomUUID(),
    workspaceId: resolveScope(opts.scope).workspaceId,
    contentId: item.id,
    fetchedAt,
    source,
    views,
    likes,
    comments,
    shares,
    bookmarks,
    createdAt: resolveNow(opts).toISOString(),
  };
  if (conn.dialect === "sqlite") {
    await conn.db
      .insert(conn.schema.contentMetrics)
      .values({ ...row, rawPayload });
  } else {
    await conn.db.insert(conn.schema.contentMetrics).values({
      ...row,
      rawPayload: rawPayload ? JSON.stringify(rawPayload) : null,
    });
  }
  const rows = await rawAll<MetricSqlRow>(
    conn,
    sql`${METRIC_SELECT} FROM content_metrics m WHERE m.id = ${row.id}`,
  );
  return toMetric(rows[0]!);
}

export interface MetricsSeriesOptions {
  days?: number;
  limit?: number;
  now?: Date;
  /** v3.0 Phase 2 — workspace scope. Absent = bootstrap workspace. */
  scope?: WorkspaceScope;
}

export interface MetricsSeries {
  item: ContentItem;
  /** Oldest first — the chart order. */
  metrics: ContentMetric[];
  latest: ContentMetric | null;
  total: number;
}

/** The time series for one item, oldest first. `null` when the item is missing. */
export async function getContentMetricsSeries(
  conn: Conn,
  contentId: string,
  opts: MetricsSeriesOptions = {},
): Promise<MetricsSeries | null> {
  const item = await itemRowById(conn, contentId.trim(), opts.scope);
  if (!item) return null;
  const limit = clampInt(
    opts.limit,
    CONTENT_LIMITS.metricsPerItem,
    1,
    CONTENT_LIMITS.metricsPerItem,
  );
  let where: SQL = sql`WHERE m.content_id = ${item.id} AND ${workspaceSql(opts.scope, "m.workspace_id")}`;
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days < 0) {
      throw new ContentError(
        "invalid_input",
        '"days" must be a non-negative number.',
      );
    }
    const cutoff =
      resolveNow(opts).getTime() - Math.floor(opts.days) * 24 * 60 * 60 * 1000;
    where = sql`${where} AND m.fetched_at >= ${new Date(cutoff).toISOString()}`;
  }
  const rows = await rawAll<MetricSqlRow>(
    conn,
    sql`${METRIC_SELECT} FROM content_metrics m ${where}
        ORDER BY m.fetched_at ASC, m.created_at ASC, m.id ASC
        LIMIT ${limit}`,
  );
  const counted = await rawAll<{ n: number | string }>(
    conn,
    sql`SELECT COUNT(*) AS n FROM content_metrics m ${where}`,
  );
  const metrics = rows.map(toMetric);
  return {
    item,
    metrics,
    latest: metrics.length > 0 ? metrics[metrics.length - 1]! : null,
    total: num(counted[0]?.n ?? 0),
  };
}

// ── Overview ─────────────────────────────────────────────────────────────

export interface ContentOverview {
  /** The window, or null for all-time. Undated items are excluded when set. */
  days: number | null;
  items: number;
  withMetrics: number;
  snapshots: number;
  /** Items skipped by the window for having no publish date. */
  excludedUndated: number;
  /** Sum of latest-known views (items never measured contribute nothing). */
  totalViews: number;
  top: ContentItemSummary[];
  byPlatform: Array<{ platform: string; items: number; views: number }>;
}

/**
 * The library at a glance: windowed totals, the top 5 by latest views, and a
 * per-platform breakdown. Three queries + a JS join regardless of library
 * size — no per-item round-trips.
 */
export async function getContentOverview(
  conn: Conn,
  opts: { days?: number; now?: Date; scope?: WorkspaceScope } = {},
): Promise<ContentOverview> {
  let days: number | null = null;
  let where: SQL = sql` WHERE ${workspaceSql(opts.scope, "i.workspace_id")}`;
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days < 0) {
      throw new ContentError(
        "invalid_input",
        '"days" must be a non-negative number.',
      );
    }
    days = Math.floor(opts.days);
    const cutoff = resolveNow(opts).getTime() - days * 24 * 60 * 60 * 1000;
    where = sql`${where} AND i.published_at IS NOT NULL AND i.published_at >= ${new Date(cutoff).toISOString()}`;
  }

  const itemRows = await rawAll<ItemSqlRow>(
    conn,
    sql`${ITEM_SELECT} FROM content_items i${where}
        ORDER BY (i.published_at IS NULL), i.published_at DESC, i.title ASC`,
  );
  const items = itemRows.map(toItem);

  let excludedUndated = 0;
  if (days !== null) {
    const rows = await rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM content_items i
          WHERE i.published_at IS NULL AND ${workspaceSql(opts.scope, "i.workspace_id")}`,
    );
    excludedUndated = num(rows[0]?.n ?? 0);
  }

  if (items.length === 0) {
    return {
      days,
      items: 0,
      withMetrics: 0,
      snapshots: 0,
      excludedUndated,
      totalViews: 0,
      top: [],
      byPlatform: [],
    };
  }

  const summaries = await enrichSummaries(conn, items, opts.scope);

  let totalViews = 0;
  let withMetrics = 0;
  let snapshots = 0;
  const platformAgg = new Map<string, { items: number; views: number }>();
  for (const s of summaries) {
    snapshots += s.metricsCount;
    const views = s.latestMetrics?.views ?? null;
    if (s.latestMetrics) withMetrics++;
    if (views !== null) totalViews += views;
    const agg = platformAgg.get(s.platform) ?? { items: 0, views: 0 };
    agg.items++;
    if (views !== null) agg.views += views;
    platformAgg.set(s.platform, agg);
  }

  const top = summaries
    .filter(
      (s) =>
        s.latestMetrics?.views !== null && s.latestMetrics?.views !== undefined,
    )
    .sort(
      (a, b) =>
        b.latestMetrics!.views! - a.latestMetrics!.views! ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 5);

  const byPlatform = [...platformAgg.entries()]
    .map(([platform, agg]) => ({ platform, ...agg }))
    .sort(
      (a, b) =>
        b.views - a.views ||
        b.items - a.items ||
        a.platform.localeCompare(b.platform),
    );

  return {
    days,
    items: items.length,
    withMetrics,
    snapshots,
    excludedUndated,
    totalViews,
    top,
    byPlatform,
  };
}

// ── Import ───────────────────────────────────────────────────────────────

export interface ImportContentOptions extends ContentOptions {
  /** Raw CSV; parsed with `parseContentCsv`. */
  csv?: string;
  /** A raw RSS/Atom body; parsed with `parseFeedXml`. */
  feedXml?: string;
  /** Pre-parsed rows (the web route parses once and validates before writing). */
  rows?: ParsedContentRow[];
  /** Override the platform for every row (feed imports default per-link). */
  platform?: ContentPlatform | string;
  source?: ContentSource | string;
  /** Report only — no writes. */
  dryRun?: boolean;
}

export interface ImportContentSummary {
  items: number;
  created: number;
  existing: number;
  errors: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; reason: string }>;
  feed: { title: string | null; link: string | null } | null;
  dryRun: boolean;
}

/**
 * Import content from a CSV or a feed body. Idempotent: re-importing the
 * same input writes nothing and reports every row as `existing`.
 */
export async function importContent(
  conn: Conn,
  opts: ImportContentOptions = {},
): Promise<ImportContentSummary> {
  const given = [
    opts.csv !== undefined,
    opts.feedXml !== undefined,
    opts.rows !== undefined,
  ].filter(Boolean).length;
  if (given !== 1) {
    throw new ContentError(
      "invalid_input",
      'Exactly one of "csv", "feedXml" or "rows" is required.',
    );
  }
  const dryRun = opts.dryRun === true;
  const source = whitelist(opts.source, CONTENT_SOURCES, "source", "import");
  const platformOverride =
    opts.platform === undefined ||
    opts.platform === null ||
    opts.platform === ""
      ? null
      : parsePlatform(String(opts.platform));

  const parsed =
    opts.rows !== undefined
      ? {
          rows: opts.rows,
          errors: [] as ImportContentSummary["errors"],
          warnings: [] as ImportContentSummary["warnings"],
          feed: null as ImportContentSummary["feed"],
        }
      : opts.csv !== undefined
        ? {
            ...parseContentCsv(opts.csv),
            feed: null as ImportContentSummary["feed"],
          }
        : (() => {
            const feed = parseFeedXml(opts.feedXml!);
            return {
              rows: feed.rows,
              errors: feed.errors,
              warnings: feed.warnings,
              feed: feed.feed,
            };
          })();

  const summary: ImportContentSummary = {
    items: 0,
    created: 0,
    existing: 0,
    errors: parsed.errors,
    warnings: parsed.warnings,
    feed: parsed.feed,
    dryRun,
  };
  if (parsed.rows.length === 0) return summary;

  const now = resolveNow(opts);
  for (const row of parsed.rows) {
    summary.items++;
    const input: AddContentItemInput = {
      url: row.url,
      title: row.title,
      platform: platformOverride ?? row.platform,
      type: row.type,
      publishedAt: row.publishedAt,
      author: row.author,
      tags: row.tags,
      summary: row.summary,
      source,
    };
    if (dryRun) {
      if (await itemRowByUrlNorm(conn, row.urlNorm, opts.scope))
        summary.existing++;
      else summary.created++;
      continue;
    }
    const { created } = await upsertContentItem(conn, input, {
      now,
      scope: opts.scope,
    });
    if (created) summary.created++;
    else summary.existing++;
  }

  if (!dryRun) {
    await writeActivityLog(
      conn,
      {
        action: "content.imported",
        entityType: "content",
        entityId: null,
        metadata: {
          items: summary.items,
          created: summary.created,
          existing: summary.existing,
          source,
        },
      },
      opts.scope,
    );
  }
  return summary;
}

// ── Mentions ─────────────────────────────────────────────────────────────

interface MentionSqlRow extends Record<string, unknown> {
  content_id: string;
  contact_id: string;
  full_name: string;
  email: string | null;
  context: string | null;
}

function toMention(r: MentionSqlRow): ContentMention {
  return {
    contentId: r.content_id,
    contactId: r.contact_id,
    fullName: r.full_name,
    email: r.email,
    context: r.context,
  };
}

/**
 * Link a contact to a piece of content ("co-authored", "mentioned").
 * Idempotent: re-adding updates the context when one is given.
 */
export async function addContentMention(
  conn: Conn,
  input: { contentId: string; contactId: string; context?: string | null },
  scope?: WorkspaceScope,
): Promise<{ mention: ContentMention; created: boolean }> {
  const contentId = input.contentId?.trim() ?? "";
  const contactId = input.contactId?.trim() ?? "";
  if (!contentId || !contactId) {
    throw new ContentError(
      "invalid_input",
      "Both contentId and contactId are required.",
    );
  }
  const item = await itemRowById(conn, contentId, scope);
  if (!item)
    throw new ContentError("not_found", `No content with id "${contentId}".`);
  const contact = await getContactById(conn, contactId, scope);
  if (!contact) {
    throw new ContentError(
      "not_found",
      `No contact with id "${contactId}". Soft-deleted contacts cannot be mentioned.`,
    );
  }
  const context = text(input.context, CONTENT_LIMITS.mentionContext, "context");

  const existing = await rawAll<MentionSqlRow>(
    conn,
    sql`SELECT m.content_id AS content_id, c.id AS contact_id, c.full_name AS full_name,
               c.email AS email, m.context AS context
        FROM content_mentions m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.content_id = ${item.id} AND m.contact_id = ${contact.id}
          AND ${workspaceSql(scope, "m.workspace_id")}
          AND ${workspaceSql(scope, "c.workspace_id")}`,
  );
  if (existing[0]) {
    if (context !== null && context !== existing[0].context) {
      if (conn.dialect === "sqlite") {
        await conn.db
          .update(conn.schema.contentMentions)
          .set({ context })
          .where(
            and(
              eq(conn.schema.contentMentions.contentId, item.id),
              eq(conn.schema.contentMentions.contactId, contact.id),
            ),
          );
      } else {
        await conn.db
          .update(conn.schema.contentMentions)
          .set({ context })
          .where(
            and(
              eq(conn.schema.contentMentions.contentId, item.id),
              eq(conn.schema.contentMentions.contactId, contact.id),
            ),
          );
      }
      existing[0].context = context;
    }
    return { mention: toMention(existing[0]), created: false };
  }

  const row = {
    contentId: item.id,
    contactId: contact.id,
    context,
    workspaceId: resolveScope(scope).workspaceId,
  };
  if (conn.dialect === "sqlite") {
    await conn.db.insert(conn.schema.contentMentions).values(row);
  } else {
    await conn.db.insert(conn.schema.contentMentions).values(row);
  }
  await writeActivityLog(
    conn,
    {
      action: "content.mention_added",
      entityType: "content",
      entityId: item.id,
      metadata: { contactId: contact.id, context },
    },
    scope,
  );
  return {
    mention: {
      contentId: item.id,
      contactId: contact.id,
      fullName: contact.fullName,
      email: contact.email ?? null,
      context,
    },
    created: true,
  };
}

/** Remove one mention. Never an error when the row is already gone. */
export async function removeContentMention(
  conn: Conn,
  input: { contentId: string; contactId: string },
  scope?: WorkspaceScope,
): Promise<{ contentId: string; contactId: string; removed: boolean }> {
  const contentId = input.contentId?.trim() ?? "";
  const contactId = input.contactId?.trim() ?? "";
  if (!contentId || !contactId) {
    throw new ContentError(
      "invalid_input",
      "Both contentId and contactId are required.",
    );
  }
  const existing = await rawAll<{ content_id: string }>(
    conn,
    sql`SELECT content_id FROM content_mentions m
        WHERE m.content_id = ${contentId} AND m.contact_id = ${contactId}
          AND ${workspaceSql(scope, "m.workspace_id")}
        LIMIT 1`,
  );
  const wsMentions = workspaceSql(scope, "content_mentions.workspace_id");
  if (conn.dialect === "sqlite") {
    await conn.db.run(
      sql`DELETE FROM content_mentions WHERE content_id = ${contentId}
          AND contact_id = ${contactId} AND ${wsMentions}`,
    );
  } else {
    await conn.db.execute(
      sql`DELETE FROM content_mentions WHERE content_id = ${contentId}
          AND contact_id = ${contactId} AND ${wsMentions}`,
    );
  }
  const removed = existing.length > 0;
  if (removed) {
    await writeActivityLog(
      conn,
      {
        action: "content.mention_removed",
        entityType: "content",
        entityId: contentId,
        metadata: { contactId },
      },
      scope,
    );
  }
  return { contentId, contactId, removed };
}

/** Who a piece of content involves — live contacts only, by name. */
export async function listContentMentions(
  conn: Conn,
  contentId: string,
  scope?: WorkspaceScope,
): Promise<ContentMention[]> {
  const rows = await rawAll<MentionSqlRow>(
    conn,
    sql`SELECT m.content_id AS content_id, c.id AS contact_id, c.full_name AS full_name,
               c.email AS email, m.context AS context
        FROM content_mentions m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.content_id = ${contentId.trim()} AND c.deleted_at IS NULL
          AND ${workspaceSql(scope, "m.workspace_id")}
          AND ${workspaceSql(scope, "c.workspace_id")}
        ORDER BY c.full_name ASC`,
  );
  return rows.map(toMention);
}

/** Content mentioning one contact, newest-published first — for the contact page. */
export async function listContactContent(
  conn: Conn,
  contactId: string,
  scope?: WorkspaceScope,
): Promise<ContentItem[]> {
  const rows = await rawAll<ItemSqlRow>(
    conn,
    sql`${ITEM_SELECT} FROM content_items i
        JOIN content_mentions m ON m.content_id = i.id
        WHERE m.contact_id = ${contactId.trim()}
          AND ${workspaceSql(scope, "m.workspace_id")}
          AND ${workspaceSql(scope, "i.workspace_id")}
        ORDER BY (i.published_at IS NULL), i.published_at DESC, i.title ASC`,
  );
  return rows.map(toItem);
}

// ── Status ───────────────────────────────────────────────────────────────

export async function contentStatus(
  conn: Conn,
  scope?: WorkspaceScope,
): Promise<ContentStatus> {
  const [items, snapshots, mentions, withMetrics] = await Promise.all([
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM content_items WHERE ${workspaceSql(scope)}`,
    ),
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM content_metrics WHERE ${workspaceSql(scope)}`,
    ),
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM content_mentions m
          JOIN contacts c ON c.id = m.contact_id
          WHERE c.deleted_at IS NULL
            AND ${workspaceSql(scope, "m.workspace_id")}
            AND ${workspaceSql(scope, "c.workspace_id")}`,
    ),
    rawAll<{ n: number | string }>(
      conn,
      sql`SELECT COUNT(DISTINCT content_id) AS n FROM content_metrics WHERE ${workspaceSql(scope)}`,
    ),
  ]);
  return {
    items: num(items[0]?.n ?? 0),
    withMetrics: num(withMetrics[0]?.n ?? 0),
    snapshots: num(snapshots[0]?.n ?? 0),
    mentions: num(mentions[0]?.n ?? 0),
  };
}
