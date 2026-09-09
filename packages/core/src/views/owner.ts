// v2.5 Phase 1 — owner-view detection.
//
// The analytics surface must never count the owner looking at their own card.
// Two signals feed `profile_views.is_owner_view`:
//
//   1. An authenticated owner session (cookie/session — the web beacon
//      decides, Phase 2/3; nothing here can see cookies, and nothing here
//      tries).
//   2. The same-IP heuristic below: a view whose *daily-salted* IP hash
//      matches a view already confirmed as the owner earlier that day
//      (e.g. the owner logged in, loaded /settings/card, then opened the
//      public /card in another browser or from the same phone on Wi-Fi).
//
// Labeling only — never blocking, never deletion. The heuristic is bounded
// by design: because the salt rotates every UTC day, an owner hash recorded
// yesterday can never match a visitor hash today, so the heuristic cannot
// chase people across days even if a NAT IP is shared with a neighbour.
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { rawAll } from "../search/indexer";
import { BOOTSTRAP_WORKSPACE_ID } from "../workspaces/scope";

type Conn = SqliteConn | PgConn;

/** How far back "a recent owner session" reaches, in hours (≤ 24 keeps the
 * lookback inside one salt day for the common case). */
export const OWNER_VIEW_LOOKBACK_HOURS = 24;

/**
 * Distinct `viewer_ip` hashes of views already flagged `is_owner_view` within
 * the lookback window. Empty when the owner never browsed their own card.
 */
export async function recentOwnerViewIpHashes(
  conn: Conn,
  options: { now?: Date; workspaceId?: string } = {},
): Promise<string[]> {
  const workspaceId = options.workspaceId ?? BOOTSTRAP_WORKSPACE_ID;
  const since = new Date(
    (options.now ?? new Date()).getTime() -
      OWNER_VIEW_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();
  const rows = await rawAll<{ viewer_ip: string }>(
    conn,
    sql`SELECT DISTINCT viewer_ip
        FROM profile_views
        WHERE is_owner_view = true
          AND viewed_at >= ${since}
          AND workspace_id = ${workspaceId}
          AND viewer_ip IS NOT NULL`,
  );
  return rows.map((r) => r.viewer_ip);
}

export interface OwnerViewSignals {
  /** True when the request carried an authenticated owner session. */
  authenticatedOwnerSession: boolean;
  /** Daily-salted hash of the viewer IP (null when the request has no IP). */
  ipHash: string | null;
  /** Output of `recentOwnerViewIpHashes` at ingestion time. */
  recentOwnerIpHashes: readonly string[];
}

/**
 * Should this view be labeled `is_owner_view`? An authenticated session wins
 * outright; otherwise the salted IP must match a view already confirmed as
 * the owner inside the lookback window. This only sets a boolean that
 * analytics excludes — nothing here blocks, rates, or drops anything.
 */
export function shouldMarkOwnerView(signals: OwnerViewSignals): boolean {
  if (signals.authenticatedOwnerSession) return true;
  return (
    signals.ipHash !== null &&
    signals.recentOwnerIpHashes.includes(signals.ipHash)
  );
}
