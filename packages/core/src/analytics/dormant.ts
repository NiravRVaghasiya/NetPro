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
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  daysAgoIso,
  daysBetween,
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type DormantContact,
} from "./types";

interface DormantRow {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  lastInteraction: string | null;
  createdAt: string;
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
  const c = conn.schema.contacts;

  const selection = {
    id: c.id,
    fullName: c.fullName,
    company: c.company,
    role: c.role,
    relationshipScore: c.relationshipScore,
    lastInteraction: c.lastInteraction,
    createdAt: c.createdAt,
  };
  const where = sql`${c.deletedAt} IS NULL AND coalesce(${c.lastInteraction}, ${c.createdAt}) < ${cutoff}`;
  const order = sql`coalesce(${c.lastInteraction}, ${c.createdAt}) asc, ${c.relationshipScore} desc`;

  let rows: DormantRow[];
  if (conn.dialect === "sqlite") {
    rows = await conn.db
      .select(selection)
      .from(c)
      .where(where)
      .orderBy(order)
      .limit(limit)
      .all();
  } else {
    rows = await conn.db.select(selection).from(c).where(where).orderBy(order).limit(limit);
  }

  return rows.map((row) => {
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
  });
}
