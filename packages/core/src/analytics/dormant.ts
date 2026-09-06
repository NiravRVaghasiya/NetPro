// packages/core/src/analytics/dormant.ts
//
// The reconnect list: contacts whose last known touchpoint is older than the
// dormancy window.
//
// Dormancy definition: `COALESCE(last_interaction, created_at) < now − days`.
// A contact never interacted with is measured from its connection date —
// treating NULL as "not dormant" would hide an entire fresh import, which is
// exactly the population LinkedIn Premium's "keep in touch" surface exists
// for. Filtering, ordering, and limiting happen in SQL; the fragment is plain
// ANSI (ISO-8601 TEXT comparisons) so SQLite and Postgres behave identically.
// Drizzle's typed builders need dialect-narrowed columns, so — same as the
// search executor — the WHERE/ORDER fragments are rebuilt per branch.
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  daysAgoIso,
  daysBetween,
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type DormantContact,
} from "./types";

/** Map a DB row to the DormantContact shape (dialect-agnostic). */
function toDormant(
  now: Date,
  row: {
    id: string;
    fullName: string;
    company: string | null;
    role: string | null;
    relationshipScore: number | null;
    lastInteraction: string | null;
    createdAt: string;
  },
): DormantContact {
  const touch = row.lastInteraction ?? row.createdAt;
  return {
    id: row.id,
    fullName: row.fullName,
    company: row.company,
    role: row.role,
    relationshipScore: row.relationshipScore,
    lastInteraction: row.lastInteraction,
    daysSince: daysBetween(now, touch),
  };
}

/**
 * Dormant ties, most-relevant first: relationship score desc, then
 * longest-ago touchpoint first. `lastInteraction` on each row is the raw
 * stored interaction date (possibly null); `daysSince` measures from the
 * effective touchpoint (`lastInteraction ?? createdAt`).
 */
export async function getDormantContacts(
  conn: SqliteConn | PgConn,
  options: AnalyticsOptions = {},
): Promise<DormantContact[]> {
  const { dormantDays, limit, now } = resolveAnalyticsOptions(options);
  const cutoff = daysAgoIso(now, dormantDays);

  if (conn.dialect === "sqlite") {
    const c = conn.schema.contacts;
    const rows = await conn.db
      .select({
        id: c.id,
        fullName: c.fullName,
        company: c.company,
        role: c.role,
        relationshipScore: c.relationshipScore,
        lastInteraction: c.lastInteraction,
        createdAt: c.createdAt,
      })
      .from(c)
      .where(
        sql`${c.deletedAt} IS NULL AND coalesce(${c.lastInteraction}, ${c.createdAt}) < ${cutoff}`,
      )
      .orderBy(
        sql`coalesce(${c.lastInteraction}, ${c.createdAt}) asc, ${c.relationshipScore} desc`,
      )
      .limit(limit)
      .all();
    return rows.map((row) => toDormant(now, row));
  }

  const c = conn.schema.contacts;
  const rows = await conn.db
    .select({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      role: c.role,
      relationshipScore: c.relationshipScore,
      lastInteraction: c.lastInteraction,
      createdAt: c.createdAt,
    })
    .from(c)
    .where(
      sql`${c.deletedAt} IS NULL AND coalesce(${c.lastInteraction}, ${c.createdAt}) < ${cutoff}`,
    )
    .orderBy(
      sql`coalesce(${c.lastInteraction}, ${c.createdAt}) asc, ${c.relationshipScore} desc`,
    )
    .limit(limit);
  return rows.map((row) => toDormant(now, row));
}
