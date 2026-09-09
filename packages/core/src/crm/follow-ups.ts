// packages/core/src/crm/follow-ups.ts
//
// Follow-up reminders: promises to yourself about other people. Create with
// an explicit due date or a relative one, list by bucket (overdue /
// due-today / upcoming), complete, snooze, cancel. Recurring follow-ups
// re-arm on completion instead of closing the loop.
//
// Bucketing is by UTC day against an injectable `now`, and a snooze only
// moves a follow-up *later*: its effective due date is
// max(dueAt, snoozedUntil). Everything is ANSI SQL + pure JS bucketing, so
// SQLite and Postgres behave identically.
//
// v3.0 Phase 3 — assignment: follow-ups gain `assigned_to` (nullable user id;
// null = anyone). Filters "assigned to me" and "unassigned" surface in
// /contacts and dashboard. Reassignment on member removal falls back to
// unassigned with an audit log entry.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getContactById } from '../ai/resolve-contact';
import { writeActivityLog } from './activity';
import {
  CRM_LIMITS,
  CrmError,
  MAX_DURATION_MS,
  optionalText,
  parseDurationMs,
  resolveNow,
  startOfUtcDay,
  toValidatedIso,
  DAY_MS,
  type CrmOptions,
} from './types';
import { resolveScope, workspacePredicate, type WorkspaceScope } from '../workspaces/scope';

export interface FollowUpRow {
  id: string;
  contactId: string;
  contactName: string;
  contactCompany: string | null;
  /** v3.0 Phase 2 — workspace user id that created this, null for system path. */
  createdByUser?: string | null;
  /** v3.0 Phase 3 — who this is assigned to, null = anyone/unassigned. */
  assignedTo?: string | null;
  reason: string | null;
  dueAt: string;
  snoozedUntil: string | null;
  /** max(dueAt, snoozedUntil) — what the buckets and sorting use. */
  effectiveDueAt: string;
  status: string;
  completedAt: string | null;
  recurring: boolean;
  recurrenceRule: string | null;
  createdAt: string;
}

export type FollowUpView =
  | 'pending'
  | 'overdue'
  | 'due-today'
  | 'upcoming'
  | 'completed'
  | 'cancelled'
  | 'all';

export interface FollowUpCounts {
  overdue: number;
  dueToday: number;
  upcoming: number;
  pending: number;
}

export interface FollowUpSummary {
  followUps: FollowUpRow[];
  counts: FollowUpCounts;
}

export function effectiveDueAt(dueAt: string, snoozedUntil: string | null): string {
  return snoozedUntil !== null && snoozedUntil > dueAt ? snoozedUntil : dueAt;
}

interface FollowUpDbRow {
  id: string;
  contactId: string;
  contactName: string;
  contactCompany: string | null;
  createdByUser?: string | null;
  assignedTo?: string | null;
  reason: string | null;
  dueAt: string;
  snoozedUntil: string | null;
  status: string | null;
  completedAt: string | null;
  recurring: boolean | null;
  recurrenceRule: string | null;
  createdAt: string;
}

function toFollowUpRow(row: FollowUpDbRow): FollowUpRow {
  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.contactName,
    contactCompany: row.contactCompany,
    createdByUser: row.createdByUser ?? null,
    assignedTo: row.assignedTo ?? null,
    reason: row.reason,
    dueAt: row.dueAt,
    snoozedUntil: row.snoozedUntil,
    effectiveDueAt: effectiveDueAt(row.dueAt, row.snoozedUntil),
    status: row.status ?? 'pending',
    completedAt: row.completedAt,
    recurring: row.recurring ?? false,
    recurrenceRule: row.recurrenceRule,
    createdAt: row.createdAt,
  };
}

export interface CreateFollowUpInput {
  contactId: string;
  /** Absolute due date (ISO string or Date). Wins over `dueInMs`. */
  dueAt?: string | Date | null;
  /** Relative due date in milliseconds from now (CLI `--follow-up 7d`). */
  dueInMs?: number | null;
  reason?: string | null;
  /** Simple duration rule (`7d`, `30d`) — presence makes it recurring. */
  recurrenceRule?: string | null;
  /** v3.0 Phase 3 — assign to a workspace user id (null = unassigned). */
  assignedTo?: string | null;
}

/**
 * Create a pending follow-up. Requires exactly a due target (`dueAt` or
 * `dueInMs`); past due dates are allowed and simply land in \"overdue\".
 */
export async function createFollowUp(
  conn: SqliteConn | PgConn,
  input: CreateFollowUpInput,
  opts: CrmOptions = {},
  scope?: WorkspaceScope
): Promise<FollowUpRow> {
  const now = resolveNow(opts);
  const resolved = resolveScope(scope);

  if (!input.contactId || typeof input.contactId !== 'string' || !input.contactId.trim()) {
    throw new CrmError('invalid_input', 'A contactId is required to create a follow-up.');
  }
  const contact = await getContactById(conn, input.contactId.trim(), scope);
  if (!contact) {
    throw new CrmError(
      'not_found',
      `No contact with id \"${input.contactId.trim()}\". Find the right id with \"netpro search\".`
    );
  }

  let dueAt: string;
  if (input.dueAt !== undefined && input.dueAt !== null) {
    dueAt = toValidatedIso(input.dueAt, 'dueAt', now, { maxPastMs: MAX_DURATION_MS });
  } else if (input.dueInMs !== undefined && input.dueInMs !== null) {
    if (!Number.isFinite(input.dueInMs) || input.dueInMs <= 0) {
      throw new CrmError('invalid_input', 'dueInMs must be a positive number of milliseconds.');
    }
    if (input.dueInMs > MAX_DURATION_MS) {
      throw new CrmError('invalid_input', 'dueInMs exceeds the 5-year maximum.');
    }
    dueAt = new Date(now.getTime() + input.dueInMs).toISOString();
  } else {
    throw new CrmError('invalid_input', 'Either dueAt or dueInMs is required.');
  }

  const reason = optionalText(input.reason, CRM_LIMITS.reason, 'reason') ?? null;
  const recurrenceRule = optionalText(input.recurrenceRule, 50, 'recurrenceRule') ?? null;
  if (recurrenceRule !== null) parseDurationMs(recurrenceRule); // validate or throw
  const assignedTo =
    input.assignedTo !== undefined && input.assignedTo !== null
      ? String(input.assignedTo).trim() || null
      : null;

  const row = {
    id: randomUUID(),
    workspaceId: resolved.workspaceId,
    createdByUser: resolved.userId === 'system' ? null : resolved.userId,
    assignedTo,
    contactId: contact.id,
    reason,
    dueAt,
    snoozedUntil: null,
    status: 'pending' as const,
    completedAt: null,
    recurring: recurrenceRule !== null,
    recurrenceRule,
    createdAt: now.toISOString(),
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.followUps).values(row);
  } else {
    await conn.db.insert(conn.schema.followUps).values(row);
  }

  await writeActivityLog(
    conn,
    {
      action: 'followup.created',
      entityType: 'contact',
      entityId: contact.id,
      metadata: { followUpId: row.id, dueAt, recurring: row.recurring, assignedTo },
    },
    scope,
  );

  return toFollowUpRow({
    ...row,
    contactName: contact.fullName,
    contactCompany: contact.company,
  });
}

const MAX_LIST_LIMIT = 200;

async function selectPendingRows(
  conn: SqliteConn | PgConn,
  contactId?: string,
  scope?: WorkspaceScope,
  filters?: { assignedTo?: string | null; assignedToMe?: string; unassigned?: boolean }
): Promise<FollowUpDbRow[]> {
  const assignedTo = filters?.assignedTo;
  const assignedToMe = filters?.assignedToMe;
  const unassigned = filters?.unassigned;
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    const c = conn.schema.contacts;
    return conn.db
      .select({
        id: f.id,
        contactId: f.contactId,
        contactName: c.fullName,
        contactCompany: c.company,
        createdByUser: f.createdByUser,
        assignedTo: f.assignedTo,
        reason: f.reason,
        dueAt: f.dueAt,
        snoozedUntil: f.snoozedUntil,
        status: f.status,
        completedAt: f.completedAt,
        recurring: f.recurring,
        recurrenceRule: f.recurrenceRule,
        createdAt: f.createdAt,
      })
      .from(f)
      .innerJoin(c, eq(f.contactId, c.id))
      .where(
        and(
          eq(f.status, 'pending'),
          isNull(c.deletedAt),
          workspacePredicate(scope, f.workspaceId),
          contactId ? eq(f.contactId, contactId) : undefined,
          assignedTo !== undefined ? (assignedTo === null ? isNull(f.assignedTo) : eq(f.assignedTo, assignedTo)) : undefined,
          assignedToMe ? eq(f.assignedTo, assignedToMe) : undefined,
          unassigned ? isNull(f.assignedTo) : undefined,
        ),
      );
  }
  const f = conn.schema.followUps;
  const c = conn.schema.contacts;
  return conn.db
    .select({
      id: f.id,
      contactId: f.contactId,
      contactName: c.fullName,
      contactCompany: c.company,
      createdByUser: f.createdByUser,
      assignedTo: f.assignedTo,
      reason: f.reason,
      dueAt: f.dueAt,
      snoozedUntil: f.snoozedUntil,
      status: f.status,
      completedAt: f.completedAt,
      recurring: f.recurring,
      recurrenceRule: f.recurrenceRule,
      createdAt: f.createdAt,
    })
    .from(f)
    .innerJoin(c, eq(f.contactId, c.id))
    .where(
      and(
        eq(f.status, 'pending'),
        isNull(c.deletedAt),
        workspacePredicate(scope, f.workspaceId),
        contactId ? eq(f.contactId, contactId) : undefined,
        assignedTo !== undefined ? (assignedTo === null ? isNull(f.assignedTo) : eq(f.assignedTo, assignedTo)) : undefined,
        assignedToMe ? eq(f.assignedTo, assignedToMe) : undefined,
        unassigned ? isNull(f.assignedTo) : undefined,
      ),
    );
}

async function selectByStatus(
  conn: SqliteConn | PgConn,
  status: string,
  contactId: string | undefined,
  limit: number,
  scope?: WorkspaceScope,
  filters?: { assignedTo?: string | null; assignedToMe?: string; unassigned?: boolean }
): Promise<FollowUpDbRow[]> {
  const assignedTo = filters?.assignedTo;
  const assignedToMe = filters?.assignedToMe;
  const unassigned = filters?.unassigned;
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    const c = conn.schema.contacts;
    return conn.db
      .select({
        id: f.id,
        contactId: f.contactId,
        contactName: c.fullName,
        contactCompany: c.company,
        createdByUser: f.createdByUser,
        assignedTo: f.assignedTo,
        reason: f.reason,
        dueAt: f.dueAt,
        snoozedUntil: f.snoozedUntil,
        status: f.status,
        completedAt: f.completedAt,
        recurring: f.recurring,
        recurrenceRule: f.recurrenceRule,
        createdAt: f.createdAt,
      })
      .from(f)
      .innerJoin(c, eq(f.contactId, c.id))
      .where(
        and(
          eq(f.status, status),
          workspacePredicate(scope, f.workspaceId),
          contactId ? eq(f.contactId, contactId) : undefined,
          assignedTo !== undefined ? (assignedTo === null ? isNull(f.assignedTo) : eq(f.assignedTo, assignedTo)) : undefined,
          assignedToMe ? eq(f.assignedTo, assignedToMe) : undefined,
          unassigned ? isNull(f.assignedTo) : undefined,
        ),
      )
      .orderBy(desc(f.completedAt))
      .limit(limit);
  }
  const f = conn.schema.followUps;
  const c = conn.schema.contacts;
  return conn.db
    .select({
      id: f.id,
      contactId: f.contactId,
      contactName: c.fullName,
      contactCompany: c.company,
      createdByUser: f.createdByUser,
      assignedTo: f.assignedTo,
      reason: f.reason,
      dueAt: f.dueAt,
      snoozedUntil: f.snoozedUntil,
      status: f.status,
      completedAt: f.completedAt,
      recurring: f.recurring,
      recurrenceRule: f.recurrenceRule,
      createdAt: f.createdAt,
    })
    .from(f)
    .innerJoin(c, eq(f.contactId, c.id))
    .where(
      and(
        eq(f.status, status),
        workspacePredicate(scope, f.workspaceId),
        contactId ? eq(f.contactId, contactId) : undefined,
        assignedTo !== undefined ? (assignedTo === null ? isNull(f.assignedTo) : eq(f.assignedTo, assignedTo)) : undefined,
        assignedToMe ? eq(f.assignedTo, assignedToMe) : undefined,
        unassigned ? isNull(f.assignedTo) : undefined,
      ),
    )
    .orderBy(desc(f.completedAt))
    .limit(limit);
}

/**
 * List follow-ups by view with the pending counts every surface needs
 * (CLI summary, /contacts header, dashboard strip).
 *
 * Pending rows are fetched whole and bucketed in JS — day-boundary math on
 * ISO strings is where dialect date functions would diverge, and at
 * single-owner volume the row count is trivial.
 */
export async function listFollowUps(
  conn: SqliteConn | PgConn,
  options: {
    view?: FollowUpView;
    contactId?: string;
    limit?: number;
    assignedTo?: string | null;
    assignedToMe?: string;
    unassigned?: boolean;
  } & CrmOptions = {},
  scope?: WorkspaceScope
): Promise<FollowUpSummary> {
  const now = resolveNow(options);
  const view = options.view ?? 'pending';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LIST_LIMIT);
  const filters = {
    assignedTo: options.assignedTo,
    assignedToMe: options.assignedToMe,
    unassigned: options.unassigned,
  };

  if (view === 'completed' || view === 'cancelled') {
    const rows = await selectByStatus(conn, view, options.contactId, limit, scope, filters);
    return {
      followUps: rows.map(toFollowUpRow),
      counts: await pendingCounts(conn, options.contactId, now, scope, filters),
    };
  }

  const pending = (await selectPendingRows(conn, options.contactId, scope, filters)).map(toFollowUpRow);
  pending.sort((a, b) =>
    a.effectiveDueAt === b.effectiveDueAt
      ? a.contactName.localeCompare(b.contactName)
      : a.effectiveDueAt < b.effectiveDueAt
        ? -1
        : 1
  );

  const todayStart = startOfUtcDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const bucketOf = (row: FollowUpRow): 'overdue' | 'dueToday' | 'upcoming' => {
    const due = new Date(row.effectiveDueAt);
    if (due < todayStart) return 'overdue';
    if (due < tomorrowStart) return 'dueToday';
    return 'upcoming';
  };

  const counts: FollowUpCounts = { overdue: 0, dueToday: 0, upcoming: 0, pending: pending.length };
  for (const row of pending) {
    const bucket = bucketOf(row);
    if (bucket === 'overdue') counts.overdue += 1;
    else if (bucket === 'dueToday') counts.dueToday += 1;
    else counts.upcoming += 1;
  }

  let rows = pending;
  if (view === 'overdue') rows = pending.filter((r) => bucketOf(r) === 'overdue');
  else if (view === 'due-today') rows = pending.filter((r) => bucketOf(r) === 'dueToday');
  else if (view === 'upcoming') rows = pending.filter((r) => bucketOf(r) === 'upcoming');
  else if (view === 'all') {
    const others = (await selectByStatus(conn, 'completed', options.contactId, limit, scope, filters)).map(
      toFollowUpRow
    );
    rows = [...pending, ...others];
  }

  return { followUps: rows.slice(0, limit), counts };
}

async function pendingCounts(
  conn: SqliteConn | PgConn,
  contactId: string | undefined,
  now: Date,
  scope?: WorkspaceScope,
  filters?: { assignedTo?: string | null; assignedToMe?: string; unassigned?: boolean }
): Promise<FollowUpCounts> {
  const pending = (await selectPendingRows(conn, contactId, scope, filters)).map(toFollowUpRow);
  const todayStart = startOfUtcDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const counts: FollowUpCounts = { overdue: 0, dueToday: 0, upcoming: 0, pending: pending.length };
  for (const row of pending) {
    const due = new Date(row.effectiveDueAt);
    if (due < todayStart) counts.overdue += 1;
    else if (due < tomorrowStart) counts.dueToday += 1;
    else counts.upcoming += 1;
  }
  return counts;
}

async function selectById(
  conn: SqliteConn | PgConn,
  id: string,
  scope?: WorkspaceScope
): Promise<FollowUpDbRow | null> {
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    const c = conn.schema.contacts;
    const rows = await conn.db
      .select({
        id: f.id,
        contactId: f.contactId,
        contactName: c.fullName,
        contactCompany: c.company,
        createdByUser: f.createdByUser,
        assignedTo: f.assignedTo,
        reason: f.reason,
        dueAt: f.dueAt,
        snoozedUntil: f.snoozedUntil,
        status: f.status,
        completedAt: f.completedAt,
        recurring: f.recurring,
        recurrenceRule: f.recurrenceRule,
        createdAt: f.createdAt,
      })
      .from(f)
      .innerJoin(c, eq(f.contactId, c.id))
      .where(
        and(
          eq(f.id, id),
          workspacePredicate(scope, f.workspaceId),
        ),
      );
    return rows[0] ?? null;
  }
  const f = conn.schema.followUps;
  const c = conn.schema.contacts;
  const rows = await conn.db
    .select({
      id: f.id,
      contactId: f.contactId,
      contactName: c.fullName,
      contactCompany: c.company,
      createdByUser: f.createdByUser,
      assignedTo: f.assignedTo,
      reason: f.reason,
      dueAt: f.dueAt,
      snoozedUntil: f.snoozedUntil,
      status: f.status,
      completedAt: f.completedAt,
      recurring: f.recurring,
      recurrenceRule: f.recurrenceRule,
      createdAt: f.createdAt,
    })
    .from(f)
    .innerJoin(c, eq(f.contactId, c.id))
    .where(
      and(
        eq(f.id, id),
        workspacePredicate(scope, f.workspaceId),
      ),
    );
  return rows[0] ?? null;
}

async function requirePending(
  conn: SqliteConn | PgConn,
  id: string,
  scope?: WorkspaceScope
): Promise<FollowUpDbRow> {
  const row = await selectById(conn, id, scope);
  if (!row) throw new CrmError('not_found', `No follow-up with id \"${id}\".`);
  if ((row.status ?? 'pending') !== 'pending') {
    throw new CrmError('conflict', `Follow-up \"${id}\" is already ${row.status}.`);
  }
  return row;
}

export interface CompleteFollowUpResult {
  completed: FollowUpRow;
  /** The re-armed next occurrence for recurring follow-ups, else null. */
  next: FollowUpRow | null;
}

/**
 * Complete a pending follow-up. Recurring follow-ups re-arm: the next
 * occurrence is due one interval after *now* (not after the old due date —
 * \"every 30 days\" means 30 days from the last touch, and completing late
 * must not instantly re-trigger).
 */
export async function completeFollowUp(
  conn: SqliteConn | PgConn,
  id: string,
  opts: CrmOptions = {},
  scope?: WorkspaceScope
): Promise<CompleteFollowUpResult> {
  const now = resolveNow(opts);
  const row = await requirePending(conn, id, scope);

  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.followUps)
      .set({ status: 'completed', completedAt: now.toISOString() })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  } else {
    await conn.db
      .update(conn.schema.followUps)
      .set({ status: 'completed', completedAt: now.toISOString() })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  }

  let next: FollowUpRow | null = null;
  if (row.recurring && row.recurrenceRule) {
    let intervalMs: number | null;
    try {
      intervalMs = parseDurationMs(row.recurrenceRule);
    } catch {
      // Tolerate a hand-edited rule: complete, but don't re-arm.
      intervalMs = null;
    }
    if (intervalMs !== null) {
      next = await createFollowUp(
        conn,
        {
          contactId: row.contactId,
          dueInMs: intervalMs,
          reason: row.reason,
          recurrenceRule: row.recurrenceRule,
          assignedTo: row.assignedTo ?? null,
        },
        { now },
        scope,
      );
    }
  }

  await writeActivityLog(
    conn,
    {
      action: 'followup.completed',
      entityType: 'contact',
      entityId: row.contactId,
      metadata: { followUpId: id, nextFollowUpId: next?.id ?? null },
    },
    scope,
  );

  return {
    completed: toFollowUpRow({ ...row, status: 'completed', completedAt: now.toISOString() }),
    next,
  };
}

export interface SnoozeFollowUpInput {
  /** Absolute snooze target; wins over `forMs`. */
  untilIso?: string | Date | null;
  /** Relative snooze in milliseconds from now. */
  forMs?: number | null;
}

/** Push a pending follow-up's effective due date into the future. */
export async function snoozeFollowUp(
  conn: SqliteConn | PgConn,
  id: string,
  input: SnoozeFollowUpInput,
  opts: CrmOptions = {},
  scope?: WorkspaceScope
): Promise<FollowUpRow> {
  const now = resolveNow(opts);
  const row = await requirePending(conn, id, scope);

  let until: string;
  if (input.untilIso !== undefined && input.untilIso !== null) {
    until = toValidatedIso(input.untilIso, 'untilIso', now, { maxPastMs: 0, maxFutureMs: MAX_DURATION_MS });
  } else if (input.forMs !== undefined && input.forMs !== null) {
    if (!Number.isFinite(input.forMs) || input.forMs <= 0) {
      throw new CrmError('invalid_input', 'forMs must be a positive number of milliseconds.');
    }
    if (input.forMs > MAX_DURATION_MS) {
      throw new CrmError('invalid_input', 'forMs exceeds the 5-year maximum.');
    }
    until = new Date(now.getTime() + input.forMs).toISOString();
  } else {
    throw new CrmError('invalid_input', 'Either untilIso or forMs is required to snooze.');
  }

  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.followUps)
      .set({ snoozedUntil: until })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  } else {
    await conn.db
      .update(conn.schema.followUps)
      .set({ snoozedUntil: until })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  }

  await writeActivityLog(
    conn,
    {
      action: 'followup.snoozed',
      entityType: 'contact',
      entityId: row.contactId,
      metadata: { followUpId: id, snoozedUntil: until },
    },
    scope,
  );

  return toFollowUpRow({ ...row, snoozedUntil: until });
}

/** Cancel a pending follow-up (manual opt-out; nothing is sent or logged). */
export async function cancelFollowUp(
  conn: SqliteConn | PgConn,
  id: string,
  opts: CrmOptions = {},
  scope?: WorkspaceScope
): Promise<FollowUpRow> {
  const now = resolveNow(opts);
  const row = await requirePending(conn, id, scope);

  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.followUps)
      .set({ status: 'cancelled', completedAt: now.toISOString() })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  } else {
    await conn.db
      .update(conn.schema.followUps)
      .set({ status: 'cancelled', completedAt: now.toISOString() })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  }

  await writeActivityLog(
    conn,
    {
      action: 'followup.cancelled',
      entityType: 'contact',
      entityId: row.contactId,
      metadata: { followUpId: id },
    },
    scope,
  );

  return toFollowUpRow({ ...row, status: 'cancelled', completedAt: now.toISOString() });
}

/** Fetch one follow-up with its contact name, or null. */
export async function getFollowUp(
  conn: SqliteConn | PgConn,
  id: string,
  scope?: WorkspaceScope
): Promise<FollowUpRow | null> {
  const row = await selectById(conn, id, scope);
  return row ? toFollowUpRow(row) : null;
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/**
 * Resolve a full follow-up id or a unique prefix of one (CLI ergonomics —
 * nobody retypes a UUID). Prefixes match against *pending* follow-ups, the
 * actionable set; ambiguity errors with the full candidate ids.
 */
export async function resolveFollowUpId(
  conn: SqliteConn | PgConn,
  idOrPrefix: string,
  scope?: WorkspaceScope
): Promise<string> {
  const trimmed = idOrPrefix.trim();
  if (!trimmed) {
    throw new CrmError('invalid_input', 'A follow-up id (or unique prefix) is required.');
  }
  const exact = await getFollowUp(conn, trimmed, scope);
  if (exact) return exact.id;

  const pattern = `${escapeLike(trimmed)}%`;
  let matches: Array<{ id: string }>;
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    matches = await conn.db
      .select({ id: f.id })
      .from(f)
      .where(
        and(
          eq(f.status, 'pending'),
          workspacePredicate(scope, f.workspaceId),
          sql`${f.id} LIKE ${pattern} ESCAPE '!'`,
        ),
      );
  } else {
    const f = conn.schema.followUps;
    matches = await conn.db
      .select({ id: f.id })
      .from(f)
      .where(
        and(
          eq(f.status, 'pending'),
          workspacePredicate(scope, f.workspaceId),
          sql`${f.id} LIKE ${pattern} ESCAPE '!'`,
        ),
      );
  }

  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new CrmError(
      'invalid_input',
      `Follow-up prefix \"${trimmed}\" is ambiguous — ${matches.length} pending follow-ups match: ` +
        `${matches.map((m) => m.id).join(', ')}. Use a longer prefix or the full id.`
    );
  }
  throw new CrmError(
    'not_found',
    `No pending follow-up matches \"${trimmed}\". List them with \"netpro track list\".`
  );
}

/** Total follow-up count by status — pagination/telemetry helper. */
export async function countFollowUps(
  conn: SqliteConn | PgConn,
  status?: string,
  scope?: WorkspaceScope
): Promise<number> {
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    const where = status
      ? and(eq(f.status, status), workspacePredicate(scope, f.workspaceId))
      : workspacePredicate(scope, f.workspaceId);
    const rows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(f)
      .where(where);
    return Number(rows[0]?.n ?? 0);
  }
  const f = conn.schema.followUps;
  const where = status
    ? and(eq(f.status, status), workspacePredicate(scope, f.workspaceId))
    : workspacePredicate(scope, f.workspaceId);
  const rows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(f)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}

/**
 * v3.0 Phase 3 — assign a pending follow-up to a workspace user (or unassign).
 */
export async function assignFollowUp(
  conn: SqliteConn | PgConn,
  id: string,
  assignedTo: string | null,
  opts: CrmOptions = {},
  scope?: WorkspaceScope
): Promise<FollowUpRow> {
  const now = resolveNow(opts);
  const row = await requirePending(conn, id, scope);
  const trimmed = assignedTo ? assignedTo.trim() || null : null;

  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.followUps)
      .set({ assignedTo: trimmed })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  } else {
    await conn.db
      .update(conn.schema.followUps)
      .set({ assignedTo: trimmed })
      .where(
        and(
          eq(conn.schema.followUps.id, id),
          workspacePredicate(scope, conn.schema.followUps.workspaceId),
        ),
      );
  }

  await writeActivityLog(
    conn,
    {
      action: 'followup.assigned',
      entityType: 'contact',
      entityId: row.contactId,
      metadata: { followUpId: id, assignedTo: trimmed, previousAssignedTo: row.assignedTo ?? null },
    },
    scope,
  );

  return toFollowUpRow({ ...row, assignedTo: trimmed });
}

/**
 * v3.0 Phase 3 — on member removal, unassign their follow-ups.
 * Returns count of reassigned rows.
 */
export async function unassignFollowUpsForUser(
  conn: SqliteConn | PgConn,
  userId: string,
  scope?: WorkspaceScope
): Promise<number> {
  const uid = userId.trim();
  if (!uid) return 0;
  const resolved = scope ? scope : undefined;
  let updated = 0;
  if (conn.dialect === 'sqlite') {
    const f = conn.schema.followUps;
    // Count before
    const toReassign = await conn.db
      .select({ id: f.id })
      .from(f)
      .where(
        and(
          eq(f.assignedTo, uid),
          eq(f.status, 'pending'),
          workspacePredicate(resolved, f.workspaceId),
        ),
      );
    if (toReassign.length === 0) return 0;
    await conn.db
      .update(f)
      .set({ assignedTo: null })
      .where(
        and(
          eq(f.assignedTo, uid),
          eq(f.status, 'pending'),
          workspacePredicate(resolved, f.workspaceId),
        ),
      );
    updated = toReassign.length;
  } else {
    const f = conn.schema.followUps;
    const toReassign = await conn.db
      .select({ id: f.id })
      .from(f)
      .where(
        and(
          eq(f.assignedTo, uid),
          eq(f.status, 'pending'),
          workspacePredicate(resolved, f.workspaceId),
        ),
      );
    if (toReassign.length === 0) return 0;
    await conn.db
      .update(f)
      .set({ assignedTo: null })
      .where(
        and(
          eq(f.assignedTo, uid),
          eq(f.status, 'pending'),
          workspacePredicate(resolved, f.workspaceId),
        ),
      );
    updated = toReassign.length;
  }

  if (updated > 0) {
    await writeActivityLog(
      conn,
      {
        action: 'followup.unassigned_on_member_removal',
        entityType: 'workspace_member',
        entityId: uid,
        metadata: { reassignedCount: updated, userId: uid },
      },
      scope,
    );
  }

  return updated;
}
