// packages/core/src/graph/edges.ts
//
// The single write path for the `edges` table. NetPro never silently
// infers that two of *your* contacts know each other: CSV mutuals land as
// pending candidates; manual/CLI/API adds are confirmed. Symmetric pairs
// collapse (canonical order sourceId < targetId for bidirectional edges).
import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { getContactById } from "../ai/resolve-contact";
import { writeActivityLog } from "../crm/activity";
import {
  resolveScope,
  workspacePredicate,
  type WorkspaceScope,
} from "../workspaces/scope";
import {
  EDGE_RELATIONS,
  EDGE_SOURCES,
  EDGE_STATUSES,
  GRAPH_LIMITS,
  GraphError,
  optionalText,
  resolveNow,
  type EdgeRelation,
  type EdgeSource,
  type EdgeStatus,
  type GraphOptions,
} from "./types";

export interface AddEdgeInput {
  sourceId: string;
  targetId: string;
  relation?: EdgeRelation | string;
  source?: EdgeSource | string;
  strength?: number;
  confidence?: number;
  context?: string | null;
  bidirectional?: boolean;
  status?: EdgeStatus | string;
}

export interface EdgeRow {
  id: string;
  /** v3.0 Phase 2 — tenancy stamp; optional so pre-tenancy fixtures still typecheck. */
  workspaceId?: string;
  sourceId: string;
  targetId: string;
  relation: string;
  strength: number;
  context: string | null;
  bidirectional: boolean;
  source: string;
  confidence: number;
  status: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface EdgeWithNames extends EdgeRow {
  sourceName: string;
  targetName: string;
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function validateConfidence(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new GraphError(
      "invalid_input",
      "confidence must be a number between 0 and 1.",
    );
  }
  return n;
}

export function validateStrength(value: unknown): number {
  if (value === undefined || value === null) return 0.5;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new GraphError(
      "invalid_input",
      "strength must be a number between 0 and 1.",
    );
  }
  return n;
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
  ) {
    return value as T;
  }
  throw new GraphError(
    "invalid_input",
    `Unknown ${field} "${String(value)}". Expected one of: ${allowed.join(", ")}.`,
  );
}

export function canonicalPair(
  sourceId: string,
  targetId: string,
  bidirectional: boolean,
): { sourceId: string; targetId: string } {
  if (bidirectional) {
    const [a, b] = pairKey(sourceId, targetId);
    return { sourceId: a, targetId: b };
  }
  return { sourceId, targetId };
}

async function findSymmetric(
  conn: SqliteConn | PgConn,
  sourceId: string,
  targetId: string,
  scope?: WorkspaceScope,
): Promise<EdgeRow | null> {
  if (conn.dialect === "sqlite") {
    const e = conn.schema.edges;
    const rows = await conn.db
      .select()
      .from(e)
      .where(
        and(
          or(
            and(eq(e.sourceId, sourceId), eq(e.targetId, targetId)),
            and(eq(e.sourceId, targetId), eq(e.targetId, sourceId)),
          ),
          workspacePredicate(scope, e.workspaceId),
        ),
      )
      .limit(1);
    return (rows[0] as EdgeRow | undefined) ?? null;
  }
  const e = conn.schema.edges;
  const rows = await conn.db
    .select()
    .from(e)
    .where(
      and(
        or(
          and(eq(e.sourceId, sourceId), eq(e.targetId, targetId)),
          and(eq(e.sourceId, targetId), eq(e.targetId, sourceId)),
        ),
        workspacePredicate(scope, e.workspaceId),
      ),
    )
    .limit(1);
  return (rows[0] as EdgeRow | undefined) ?? null;
}

async function getEdgeById(
  conn: SqliteConn | PgConn,
  id: string,
  scope?: WorkspaceScope,
): Promise<EdgeRow | null> {
  if (conn.dialect === "sqlite") {
    const rows = await conn.db
      .select()
      .from(conn.schema.edges)
      .where(
        and(
          eq(conn.schema.edges.id, id),
          workspacePredicate(scope, conn.schema.edges.workspaceId),
        ),
      )
      .limit(1);
    return (rows[0] as EdgeRow | undefined) ?? null;
  }
  const rows = await conn.db
    .select()
    .from(conn.schema.edges)
    .where(
      and(
        eq(conn.schema.edges.id, id),
        workspacePredicate(scope, conn.schema.edges.workspaceId),
      ),
    )
    .limit(1);
  return (rows[0] as EdgeRow | undefined) ?? null;
}

/**
 * Insert or collapse a graph edge. Duplicate / reverse pairs return the
 * existing row (conflict) unless `merge` is true, in which case fields are
 * updated in place.
 */
export async function addEdge(
  conn: SqliteConn | PgConn,
  input: AddEdgeInput,
  opts: GraphOptions & { merge?: boolean } = {},
): Promise<{ edge: EdgeRow; created: boolean }> {
  const now = resolveNow(opts);
  const sourceId = input.sourceId?.trim();
  const targetId = input.targetId?.trim();
  if (!sourceId || !targetId) {
    throw new GraphError(
      "invalid_input",
      "Both sourceId and targetId are required.",
    );
  }
  if (sourceId === targetId) {
    throw new GraphError(
      "invalid_input",
      "A contact cannot be linked to themselves.",
    );
  }

  const relation = whitelist(
    input.relation,
    EDGE_RELATIONS,
    "relation",
    "manual",
  );
  const source = whitelist(input.source, EDGE_SOURCES, "source", "manual");
  const status = whitelist(
    input.status,
    EDGE_STATUSES,
    "status",
    source === "manual" ? "confirmed" : "pending",
  );
  const bidirectional = input.bidirectional !== false;
  const pair = canonicalPair(sourceId, targetId, bidirectional);
  const confidence = validateConfidence(input.confidence);
  const strength = validateStrength(input.strength);
  const context =
    optionalText(input.context, GRAPH_LIMITS.context, "context") ?? null;

  const from = await getContactById(conn, pair.sourceId, opts.scope);
  const to = await getContactById(conn, pair.targetId, opts.scope);
  if (!from || !to) {
    throw new GraphError(
      "not_found",
      `No contact with id "${!from ? pair.sourceId : pair.targetId}". Soft-deleted contacts cannot be linked.`,
    );
  }

  const existing = await findSymmetric(
    conn,
    pair.sourceId,
    pair.targetId,
    opts.scope,
  );
  if (existing) {
    if (!opts.merge) {
      throw new GraphError(
        "conflict",
        `An edge already exists between these contacts (${existing.id.slice(0, 8)}). Use merge to collapse the pair.`,
      );
    }
    const updatedAt = now.toISOString();
    const patch = {
      relation,
      source,
      status,
      strength,
      confidence,
      context,
      bidirectional,
      updatedAt,
    };
    if (conn.dialect === "sqlite") {
      await conn.db
        .update(conn.schema.edges)
        .set(patch)
        .where(
          and(
            eq(conn.schema.edges.id, existing.id),
            workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
          ),
        );
    } else {
      await conn.db
        .update(conn.schema.edges)
        .set(patch)
        .where(
          and(
            eq(conn.schema.edges.id, existing.id),
            workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
          ),
        );
    }
    return { edge: { ...existing, ...patch }, created: false };
  }

  const edge: EdgeRow = {
    id: randomUUID(),
    workspaceId: resolveScope(opts.scope).workspaceId,
    sourceId: pair.sourceId,
    targetId: pair.targetId,
    relation,
    strength,
    context,
    bidirectional,
    source,
    confidence,
    status,
    discoveredAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (conn.dialect === "sqlite") {
    await conn.db.insert(conn.schema.edges).values(edge);
  } else {
    await conn.db.insert(conn.schema.edges).values(edge);
  }

  await writeActivityLog(
    conn,
    {
      action: "edge.added",
      entityType: "edge",
      entityId: edge.id,
      metadata: {
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relation,
        status,
      },
    },
    opts.scope,
  );

  return { edge, created: true };
}

export async function removeEdge(
  conn: SqliteConn | PgConn,
  edgeId: string,
  opts: GraphOptions = {},
): Promise<EdgeRow> {
  const id = edgeId.trim();
  const existing = await getEdgeById(conn, id, opts.scope);
  if (!existing) {
    throw new GraphError("not_found", `No edge with id "${id}".`);
  }
  if (conn.dialect === "sqlite") {
    await conn.db
      .delete(conn.schema.edges)
      .where(
        and(
          eq(conn.schema.edges.id, id),
          workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
        ),
      );
  } else {
    await conn.db
      .delete(conn.schema.edges)
      .where(
        and(
          eq(conn.schema.edges.id, id),
          workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
        ),
      );
  }
  await writeActivityLog(
    conn,
    {
      action: "edge.removed",
      entityType: "edge",
      entityId: id,
    },
    opts.scope,
  );
  return existing;
}

export async function setEdgeStatus(
  conn: SqliteConn | PgConn,
  edgeId: string,
  status: EdgeStatus | string,
  opts: GraphOptions = {},
): Promise<EdgeRow> {
  const next = whitelist(status, EDGE_STATUSES, "status", "confirmed");
  const now = resolveNow(opts);
  const existing = await getEdgeById(conn, edgeId.trim(), opts.scope);
  if (!existing) {
    throw new GraphError("not_found", `No edge with id "${edgeId}".`);
  }
  const updatedAt = now.toISOString();
  if (conn.dialect === "sqlite") {
    await conn.db
      .update(conn.schema.edges)
      .set({ status: next, updatedAt })
      .where(
        and(
          eq(conn.schema.edges.id, existing.id),
          workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
        ),
      );
  } else {
    await conn.db
      .update(conn.schema.edges)
      .set({ status: next, updatedAt })
      .where(
        and(
          eq(conn.schema.edges.id, existing.id),
          workspacePredicate(opts.scope, conn.schema.edges.workspaceId),
        ),
      );
  }
  await writeActivityLog(
    conn,
    {
      action:
        next === "confirmed"
          ? "edge.confirmed"
          : next === "rejected"
            ? "edge.rejected"
            : "edge.updated",
      entityType: "edge",
      entityId: existing.id,
    },
    opts.scope,
  );
  return { ...existing, status: next, updatedAt };
}

export interface ListEdgesOptions {
  contactId?: string;
  relation?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIST = 200;

function edgeFilters(
  e: {
    sourceId: unknown;
    targetId: unknown;
    relation: unknown;
    status: unknown;
    workspaceId: unknown;
  },
  options: ListEdgesOptions,
  scope?: WorkspaceScope,
) {
  const filters = [workspacePredicate(scope, e.workspaceId as never)];
  if (options.contactId) {
    filters.push(
      or(
        eq(e.sourceId as never, options.contactId),
        eq(e.targetId as never, options.contactId),
      )!,
    );
  }
  if (options.relation) filters.push(eq(e.relation as never, options.relation));
  if (options.status) filters.push(eq(e.status as never, options.status));
  return filters.length === 1 ? filters[0] : and(...filters);
}

export async function listEdges(
  conn: SqliteConn | PgConn,
  options: ListEdgesOptions = {},
  scope?: WorkspaceScope,
): Promise<EdgeWithNames[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LIST);
  const offset = Math.max(options.offset ?? 0, 0);

  let rows: EdgeRow[];
  let contacts: Array<{ id: string; fullName: string }>;
  if (conn.dialect === "sqlite") {
    const e = conn.schema.edges;
    const src = conn.schema.contacts;
    rows = (await conn.db
      .select()
      .from(e)
      .where(edgeFilters(e, options, scope))
      .orderBy(desc(e.updatedAt))
      .limit(limit)
      .offset(offset)) as EdgeRow[];
    contacts = await conn.db
      .select({ id: src.id, fullName: src.fullName })
      .from(src)
      .where(workspacePredicate(scope, src.workspaceId));
  } else {
    const e = conn.schema.edges;
    const src = conn.schema.contacts;
    rows = (await conn.db
      .select()
      .from(e)
      .where(edgeFilters(e, options, scope))
      .orderBy(desc(e.updatedAt))
      .limit(limit)
      .offset(offset)) as EdgeRow[];
    contacts = await conn.db
      .select({ id: src.id, fullName: src.fullName })
      .from(src)
      .where(workspacePredicate(scope, src.workspaceId));
  }

  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.sourceId);
    ids.add(row.targetId);
  }
  const names = new Map<string, string>();
  for (const c of contacts) {
    if (ids.has(c.id)) names.set(c.id, c.fullName);
  }

  return rows.map((row) => ({
    ...row,
    sourceName: names.get(row.sourceId) ?? row.sourceId,
    targetName: names.get(row.targetId) ?? row.targetId,
  }));
}

export async function countEdges(
  conn: SqliteConn | PgConn,
  options: ListEdgesOptions = {},
  scope?: WorkspaceScope,
): Promise<number> {
  if (conn.dialect === "sqlite") {
    const e = conn.schema.edges;
    const rows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(e)
      .where(edgeFilters(e, options, scope));
    return Number(rows[0]?.n ?? 0);
  }
  const e = conn.schema.edges;
  const rows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(e)
    .where(edgeFilters(e, options, scope));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Collapse every symmetric pair (A→B and B→A) into one bidirectional row.
 * Returns how many duplicate rows were deleted.
 */
export async function mergeSymmetricPairs(
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<{ merged: number }> {
  let rows: EdgeRow[];
  if (conn.dialect === "sqlite") {
    const e = conn.schema.edges;
    rows = (await conn.db
      .select()
      .from(e)
      .where(workspacePredicate(scope, e.workspaceId))) as EdgeRow[];
  } else {
    const e = conn.schema.edges;
    rows = (await conn.db
      .select()
      .from(e)
      .where(workspacePredicate(scope, e.workspaceId))) as EdgeRow[];
  }
  const seen = new Map<string, EdgeRow>();
  let merged = 0;
  for (const row of rows) {
    const [a, b] = pairKey(row.sourceId, row.targetId);
    const key = `${a}|${b}`;
    const keep = seen.get(key);
    if (!keep) {
      seen.set(key, row);
      continue;
    }
    if (conn.dialect === "sqlite") {
      await conn.db
        .delete(conn.schema.edges)
        .where(eq(conn.schema.edges.id, row.id));
    } else {
      await conn.db
        .delete(conn.schema.edges)
        .where(eq(conn.schema.edges.id, row.id));
    }
    merged++;
    if (!keep.bidirectional) {
      const updatedAt = new Date().toISOString();
      if (conn.dialect === "sqlite") {
        await conn.db
          .update(conn.schema.edges)
          .set({ bidirectional: true, updatedAt })
          .where(eq(conn.schema.edges.id, keep.id));
      } else {
        await conn.db
          .update(conn.schema.edges)
          .set({ bidirectional: true, updatedAt })
          .where(eq(conn.schema.edges.id, keep.id));
      }
    }
  }
  return { merged };
}

/** Resolve a full id or unique prefix the same way follow-ups do. */
export async function resolveEdgeId(
  conn: SqliteConn | PgConn,
  idOrPrefix: string,
  scope?: WorkspaceScope,
): Promise<string> {
  const needle = idOrPrefix.trim();
  if (!needle) throw new GraphError("invalid_input", "An edge id is required.");
  const exact = await getEdgeById(conn, needle, scope);
  if (exact) return exact.id;
  let all: Array<{ id: string }>;
  if (conn.dialect === "sqlite") {
    all = await conn.db
      .select({ id: conn.schema.edges.id })
      .from(conn.schema.edges)
      .where(workspacePredicate(scope, conn.schema.edges.workspaceId));
  } else {
    all = await conn.db
      .select({ id: conn.schema.edges.id })
      .from(conn.schema.edges)
      .where(workspacePredicate(scope, conn.schema.edges.workspaceId));
  }
  const matches = all.filter((r) => r.id.startsWith(needle));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new GraphError(
      "invalid_input",
      `Ambiguous edge id prefix "${needle}" matches ${matches.length} edges.`,
    );
  }
  throw new GraphError("not_found", `No edge with id "${needle}".`);
}
