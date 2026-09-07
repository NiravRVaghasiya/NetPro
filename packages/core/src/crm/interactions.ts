// packages/core/src/crm/interactions.ts
//
// The single write path for relationship history: `logInteraction` inserts
// the row AND recomputes the contact's denormalized stats (lastInteraction,
// interactionCount, relationshipScore), so every consumer — search,
// analytics, dashboard, campaigns — reads consistent truth without triggers
// or background jobs. Shared by the CLI (`netpro track log/add`) and the web
// app (`POST /api/interactions`).
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { getContactById, type ContactRef } from '../ai/resolve-contact';
import { writeActivityLog } from './activity';
import { relationshipScoreColumn, type ScoredInteraction } from './scoring';
import {
  CRM_LIMITS,
  CrmError,
  DEFAULT_DIRECTIONS,
  INTERACTION_CHANNELS,
  INTERACTION_DIRECTIONS,
  INTERACTION_TYPES,
  optionalText,
  resolveNow,
  toValidatedIso,
  DAY_MS,
  type CrmOptions,
  type InteractionChannel,
  type InteractionDirection,
  type InteractionType,
} from './types';

/** Backdating is the core CRM use case; these bounds keep typos out of scoring. */
const MAX_FUTURE_MS = DAY_MS; // +1 day of timezone slack
const MAX_PAST_MS = 10 * 365 * DAY_MS; // 10 years

export interface LogInteractionInput {
  contactId: string;
  type: InteractionType | string;
  direction?: InteractionDirection | string | null;
  subject?: string | null;
  content?: string | null;
  channel?: InteractionChannel | string | null;
  campaignId?: string | null;
  /** When it actually happened (defaults to now; may be backdated). */
  occurredAt?: string | Date | null;
}

export interface InteractionRow {
  id: string;
  contactId: string;
  type: string;
  direction: string | null;
  subject: string | null;
  content: string | null;
  channel: string | null;
  campaignId: string | null;
  occurredAt: string;
  createdAt: string;
}

/** The denormalized contact columns recomputed on every logged interaction. */
export interface ContactStats {
  lastInteraction: string | null;
  interactionCount: number;
  /** 0–1 scale (see scoring.ts). */
  relationshipScore: number;
}

export interface LogInteractionResult {
  interaction: InteractionRow;
  stats: ContactStats;
  contact: ContactRef;
}

/** Normalized insert-ready values, produced by `validateInteractionInput`. */
interface NormalizedInteraction {
  type: InteractionType;
  direction: InteractionDirection | null;
  subject: string | null;
  content: string | null;
  channel: InteractionChannel | null;
  occurredAt: string;
}

/**
 * Validate and normalize an interaction input. Exported for tests and reused
 * by the web route so CLI and API enforce identical bounds.
 */
export function validateInteractionInput(
  input: LogInteractionInput,
  now: Date
): NormalizedInteraction {
  if (!input.contactId || typeof input.contactId !== 'string' || !input.contactId.trim()) {
    throw new CrmError('invalid_input', 'A contactId is required to log an interaction.');
  }

  const type = input.type as InteractionType;
  if (!INTERACTION_TYPES.includes(type)) {
    throw new CrmError(
      'invalid_input',
      `Unknown interaction type "${String(input.type)}". Expected one of: ${INTERACTION_TYPES.join(', ')}.`
    );
  }

  let direction: InteractionDirection | null;
  if (input.direction === undefined || input.direction === null) {
    direction = DEFAULT_DIRECTIONS[type] ?? null;
  } else if (INTERACTION_DIRECTIONS.includes(input.direction as InteractionDirection)) {
    direction = input.direction as InteractionDirection;
  } else {
    throw new CrmError(
      'invalid_input',
      `Unknown direction "${String(input.direction)}". Expected one of: ${INTERACTION_DIRECTIONS.join(', ')}.`
    );
  }

  let channel: InteractionChannel | null;
  if (input.channel === undefined || input.channel === null) {
    channel = null;
  } else if (INTERACTION_CHANNELS.includes(input.channel as InteractionChannel)) {
    channel = input.channel as InteractionChannel;
  } else {
    throw new CrmError(
      'invalid_input',
      `Unknown channel "${String(input.channel)}". Expected one of: ${INTERACTION_CHANNELS.join(', ')}.`
    );
  }

  const occurredAt = toValidatedIso(input.occurredAt ?? now, 'occurredAt', now, {
    maxFutureMs: MAX_FUTURE_MS,
    maxPastMs: MAX_PAST_MS,
  });

  return {
    type,
    direction,
    subject: optionalText(input.subject, CRM_LIMITS.subject, 'subject') ?? null,
    content: optionalText(input.content, CRM_LIMITS.content, 'content') ?? null,
    channel,
    occurredAt,
  };
}

async function campaignExists(
  conn: SqliteConn | PgConn,
  campaignId: string
): Promise<boolean> {
  if (conn.dialect === 'sqlite') {
    const rows = await conn.db
      .select({ id: conn.schema.campaigns.id })
      .from(conn.schema.campaigns)
      .where(eq(conn.schema.campaigns.id, campaignId))
      .limit(1);
    return rows.length > 0;
  }
  const rows = await conn.db
    .select({ id: conn.schema.campaigns.id })
    .from(conn.schema.campaigns)
    .where(eq(conn.schema.campaigns.id, campaignId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Load a contact's full scoring footprint (type, direction, occurredAt).
 * The recompute needs all history anyway; at single-owner volume this is
 * microseconds on the interactions(contact_id, occurred_at) index.
 */
async function loadScoredInteractions(
  conn: SqliteConn | PgConn,
  contactId: string
): Promise<ScoredInteraction[]> {
  if (conn.dialect === 'sqlite') {
    const i = conn.schema.interactions;
    return conn.db
      .select({ type: i.type, direction: i.direction, occurredAt: i.occurredAt })
      .from(i)
      .where(eq(i.contactId, contactId));
  }
  const i = conn.schema.interactions;
  return conn.db
    .select({ type: i.type, direction: i.direction, occurredAt: i.occurredAt })
    .from(i)
    .where(eq(i.contactId, contactId));
}

/**
 * Recompute and persist contacts.lastInteraction / interactionCount /
 * relationshipScore from the interaction history. `lastInteraction` is the
 * MAX occurredAt — a backdated log never rewinds it.
 */
export async function recomputeContactStats(
  conn: SqliteConn | PgConn,
  contactId: string,
  now: Date
): Promise<ContactStats> {
  const history = await loadScoredInteractions(conn, contactId);

  let lastInteraction: string | null = null;
  for (const i of history) {
    if (lastInteraction === null || i.occurredAt > lastInteraction) lastInteraction = i.occurredAt;
  }
  const stats: ContactStats = {
    lastInteraction,
    interactionCount: history.length,
    relationshipScore: relationshipScoreColumn(history, now),
  };

  const updatedAt = now.toISOString();
  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.contacts)
      .set({ ...stats, updatedAt })
      .where(eq(conn.schema.contacts.id, contactId));
  } else {
    await conn.db
      .update(conn.schema.contacts)
      .set({ ...stats, updatedAt })
      .where(eq(conn.schema.contacts.id, contactId));
  }
  return stats;
}

/** Read back the denormalized stats for one contact (timeline views). */
export async function getContactStats(
  conn: SqliteConn | PgConn,
  contactId: string
): Promise<ContactStats | null> {
  if (conn.dialect === 'sqlite') {
    const c = conn.schema.contacts;
    const rows = await conn.db
      .select({
        lastInteraction: c.lastInteraction,
        interactionCount: c.interactionCount,
        relationshipScore: c.relationshipScore,
      })
      .from(c)
      .where(eq(c.id, contactId));
    const row = rows[0];
    if (!row) return null;
    return {
      lastInteraction: row.lastInteraction,
      interactionCount: row.interactionCount ?? 0,
      relationshipScore: row.relationshipScore ?? 0,
    };
  }
  const c = conn.schema.contacts;
  const rows = await conn.db
    .select({
      lastInteraction: c.lastInteraction,
      interactionCount: c.interactionCount,
      relationshipScore: c.relationshipScore,
    })
    .from(c)
    .where(eq(c.id, contactId));
  const row = rows[0];
  if (!row) return null;
  return {
    lastInteraction: row.lastInteraction,
    interactionCount: row.interactionCount ?? 0,
    relationshipScore: row.relationshipScore ?? 0,
  };
}

/**
 * Log an interaction and refresh the contact's stats in one call.
 *
 * Not wrapped in a transaction: the two writes are adjacent, single-owner,
 * and a crash between them self-heals on the next logged interaction (stats
 * are always recomputed from history, never incremented). Same pragmatism as
 * the import pipeline.
 */
export async function logInteraction(
  conn: SqliteConn | PgConn,
  input: LogInteractionInput,
  opts: CrmOptions = {}
): Promise<LogInteractionResult> {
  const now = resolveNow(opts);
  const normalized = validateInteractionInput(input, now);
  const contactId = input.contactId.trim();

  const contact = await getContactById(conn, contactId);
  if (!contact) {
    throw new CrmError(
      'not_found',
      `No contact with id "${contactId}". Find the right id with "netpro search".`
    );
  }

  const campaignId =
    optionalText(input.campaignId, 200, 'campaignId') ?? null;
  if (campaignId !== null && !(await campaignExists(conn, campaignId))) {
    throw new CrmError('not_found', `No campaign with id "${campaignId}".`);
  }

  const interaction: InteractionRow = {
    id: randomUUID(),
    contactId: contact.id,
    type: normalized.type,
    direction: normalized.direction,
    subject: normalized.subject,
    content: normalized.content,
    channel: normalized.channel,
    campaignId,
    occurredAt: normalized.occurredAt,
    createdAt: now.toISOString(),
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.interactions).values(interaction);
  } else {
    await conn.db.insert(conn.schema.interactions).values(interaction);
  }

  const stats = await recomputeContactStats(conn, contact.id, now);
  await writeActivityLog(conn, {
    action: 'interaction.logged',
    entityType: 'contact',
    entityId: contact.id,
    metadata: { interactionId: interaction.id, type: interaction.type },
  });

  return { interaction, stats, contact };
}

export interface ListInteractionsOptions {
  contactId?: string;
  limit?: number;
  offset?: number;
}

export type InteractionWithContact = InteractionRow & { contactName: string };

const MAX_LIST_LIMIT = 200;

/**
 * Recent interactions, newest first, joined to the contact name. With
 * `contactId` this is the per-contact history; without it, the global
 * "what happened lately" feed (`netpro track list --recent`).
 */
export async function listInteractions(
  conn: SqliteConn | PgConn,
  options: ListInteractionsOptions = {}
): Promise<InteractionWithContact[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_LIST_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  if (conn.dialect === 'sqlite') {
    const i = conn.schema.interactions;
    const c = conn.schema.contacts;
    const where = options.contactId
      ? and(eq(i.contactId, options.contactId), isNull(c.deletedAt))
      : isNull(c.deletedAt);
    return conn.db
      .select({
        id: i.id,
        contactId: i.contactId,
        contactName: c.fullName,
        type: i.type,
        direction: i.direction,
        subject: i.subject,
        content: i.content,
        channel: i.channel,
        campaignId: i.campaignId,
        occurredAt: i.occurredAt,
        createdAt: i.createdAt,
      })
      .from(i)
      .innerJoin(c, eq(i.contactId, c.id))
      .where(where)
      .orderBy(desc(i.occurredAt))
      .limit(limit)
      .offset(offset);
  }

  const i = conn.schema.interactions;
  const c = conn.schema.contacts;
  const where = options.contactId
    ? and(eq(i.contactId, options.contactId), isNull(c.deletedAt))
    : isNull(c.deletedAt);
  return conn.db
    .select({
      id: i.id,
      contactId: i.contactId,
      contactName: c.fullName,
      type: i.type,
      direction: i.direction,
      subject: i.subject,
      content: i.content,
      channel: i.channel,
      campaignId: i.campaignId,
      occurredAt: i.occurredAt,
      createdAt: i.createdAt,
    })
    .from(i)
    .innerJoin(c, eq(i.contactId, c.id))
    .where(where)
    .orderBy(desc(i.occurredAt))
    .limit(limit)
    .offset(offset);
}

/** Total interaction count (optionally for one contact) — pagination helper. */
export async function countInteractions(
  conn: SqliteConn | PgConn,
  contactId?: string
): Promise<number> {
  if (conn.dialect === 'sqlite') {
    const i = conn.schema.interactions;
    const rows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(i)
      .where(contactId ? eq(i.contactId, contactId) : undefined);
    return Number(rows[0]?.n ?? 0);
  }
  const i = conn.schema.interactions;
  const rows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(i)
    .where(contactId ? eq(i.contactId, contactId) : undefined);
  return Number(rows[0]?.n ?? 0);
}
