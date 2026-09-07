// packages/core/src/crm/timeline.ts
//
// The contact-detail aggregate for `/contacts/[id]` and
// `GET /api/contacts/[id]`: profile, denormalized stats, recent interaction
// history, and pending follow-ups in one call.
import type { SqliteConn, PgConn } from '@netpro/db';
import { getContactById, type ContactRef } from '../ai/resolve-contact';
import {
  getContactStats,
  listInteractions,
  type ContactStats,
  type InteractionWithContact,
} from './interactions';
import { listFollowUps, type FollowUpRow } from './follow-ups';
import { resolveNow, type CrmOptions } from './types';

export interface ContactTimeline {
  contact: ContactRef;
  stats: ContactStats;
  interactions: InteractionWithContact[];
  /** Pending follow-ups for this contact, soonest effective due first. */
  followUps: FollowUpRow[];
}

export interface ContactTimelineOptions extends CrmOptions {
  /** Max interactions in the history (default 50, max 200). */
  interactionsLimit?: number;
}

export async function getContactTimeline(
  conn: SqliteConn | PgConn,
  contactId: string,
  opts: ContactTimelineOptions = {}
): Promise<ContactTimeline | null> {
  const now = resolveNow(opts);
  const contact = await getContactById(conn, contactId);
  if (!contact) return null;

  const [stats, interactions, followUpSummary] = await Promise.all([
    getContactStats(conn, contact.id),
    listInteractions(conn, {
      contactId: contact.id,
      limit: opts.interactionsLimit ?? 50,
    }),
    listFollowUps(conn, { view: 'pending', contactId: contact.id, limit: 50, now }),
  ]);

  return {
    contact,
    stats: stats ?? { lastInteraction: null, interactionCount: 0, relationshipScore: 0 },
    interactions,
    followUps: followUpSummary.followUps,
  };
}
