// packages/core/src/crm/contacts.ts
//
// The CRM contact list: contacts with their denormalized interaction stats
// and the next pending follow-up, paginated and sortable. One portable
// query — the follow-up column is an ANSI correlated subquery (with the
// snooze rule folded in via CASE), so SQLite and Postgres return identical
// rows. Shared by `/contacts` and `GET /api/contacts`.
import { sql, isNull, and, type SQL, type AnyColumn } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveScope, workspacePredicate, type WorkspaceScope } from '../workspaces/scope';

export type CrmContactsSort = 'recent' | 'score' | 'name' | 'follow-up';

export const CRM_CONTACTS_SORTS: CrmContactsSort[] = ['recent', 'score', 'name', 'follow-up'];

export interface CrmContactRow {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  role: string | null;
  location: string | null;
  lastInteraction: string | null;
  interactionCount: number;
  /** 0–1 scale. */
  relationshipScore: number | null;
  /** Effective due date of the soonest pending follow-up, else null. */
  nextFollowUpAt: string | null;
  createdAt: string;
}

export interface CrmContactsPage {
  contacts: CrmContactRow[];
  total: number;
  limit: number;
  offset: number;
  sort: CrmContactsSort;
}

export interface ListCrmContactsOptions {
  limit?: number;
  offset?: number;
  sort?: CrmContactsSort;
}

const MAX_LIMIT = 100;

/**
 * min(effective due) over the contact's pending follow-ups — the same
 * max(dueAt, snoozedUntil) rule the follow-up module uses, expressed in
 * ANSI SQL so it can run as a correlated subquery. The follow_ups table
 * name is identical in both dialects.
 */
function nextFollowUpSubquery(
  contactIdColumn: SQL,
  workspaceId: string,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT min(
      CASE
        WHEN follow_ups.snoozed_until IS NOT NULL AND follow_ups.snoozed_until > follow_ups.due_at
        THEN follow_ups.snoozed_until
        ELSE follow_ups.due_at
      END
    )
    FROM follow_ups
    WHERE follow_ups.contact_id = ${contactIdColumn}
      AND follow_ups.status = 'pending'
      AND follow_ups.workspace_id = ${workspaceId}
  )`;
}

export async function listCrmContacts(
  conn: SqliteConn | PgConn,
  options: ListCrmContactsOptions = {},
  scope?: WorkspaceScope
): Promise<CrmContactsPage> {
  const wsId = resolveScope(scope).workspaceId;
  const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const sort = CRM_CONTACTS_SORTS.includes(options.sort ?? 'recent')
    ? (options.sort ?? 'recent')
    : 'recent';

  if (conn.dialect === 'sqlite') {
    const c = conn.schema.contacts;
    const nextFollowUp = nextFollowUpSubquery(sql`${c.id}`, wsId);
    const rows = await conn.db
      .select({
        id: c.id,
        fullName: c.fullName,
        email: c.email,
        company: c.company,
        role: c.role,
        location: c.location,
        lastInteraction: c.lastInteraction,
        interactionCount: c.interactionCount,
        relationshipScore: c.relationshipScore,
        nextFollowUpAt: nextFollowUp,
        createdAt: c.createdAt,
      })
      .from(c)
      .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)))
      .orderBy(...crmOrderBy(sort, c.fullName, c.lastInteraction, c.relationshipScore, nextFollowUp))
      .limit(limit)
      .offset(offset);
    const countRows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(c)
      .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)));
    return {
      contacts: rows.map(normalizeRow),
      total: Number(countRows[0]?.n ?? 0),
      limit,
      offset,
      sort,
    };
  }

  const c = conn.schema.contacts;
  const nextFollowUp = nextFollowUpSubquery(sql`${c.id}`, wsId);
  const rows = await conn.db
    .select({
      id: c.id,
      fullName: c.fullName,
      email: c.email,
      company: c.company,
      role: c.role,
      location: c.location,
      lastInteraction: c.lastInteraction,
      interactionCount: c.interactionCount,
      relationshipScore: c.relationshipScore,
      nextFollowUpAt: nextFollowUp,
      createdAt: c.createdAt,
    })
    .from(c)
    .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)))
    .orderBy(...crmOrderBy(sort, c.fullName, c.lastInteraction, c.relationshipScore, nextFollowUp))
    .limit(limit)
    .offset(offset);
  const countRows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(c)
    .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)));
  return {
    contacts: rows.map(normalizeRow),
    total: Number(countRows[0]?.n ?? 0),
    limit,
    offset,
    sort,
  };
}

/**
 * NULLS LAST is supported by SQLite ≥ 3.30 and Postgres alike (the same
 * portability note as the search module's `recent` sort), so contacts with
 * no history sort to the bottom instead of dialect-dependent positions.
 */
function crmOrderBy(
  sort: CrmContactsSort,
  fullName: AnyColumn,
  lastInteraction: AnyColumn,
  relationshipScore: AnyColumn,
  nextFollowUp: SQL
): SQL[] {
  const nameAsc = sql`${fullName} ASC`;
  switch (sort) {
    case 'score':
      return [sql`${relationshipScore} DESC NULLS LAST`, nameAsc];
    case 'name':
      return [nameAsc];
    case 'follow-up':
      return [sql`${nextFollowUp} ASC NULLS LAST`, nameAsc];
    case 'recent':
    default:
      return [sql`${lastInteraction} DESC NULLS LAST`, nameAsc];
  }
}

function normalizeRow(row: {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  role: string | null;
  location: string | null;
  lastInteraction: string | null;
  interactionCount: number | null;
  relationshipScore: number | null;
  nextFollowUpAt: string | null;
  createdAt: string;
}): CrmContactRow {
  return { ...row, interactionCount: row.interactionCount ?? 0 };
}
