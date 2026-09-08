// v2.5 Phase 3 — viewer analytics: the query side of `profile_views`.
//
// Phase 1 hardened the table, Phase 2 gave it a producer; this module is the
// consumer. Everything the owner sees about "who viewed your profile" — the
// CLI (`netpro card --views`, `netpro analyze --views`), the owner-only APIs
// (`GET /api/card/views`, the `views` block of `GET /api/analytics`), the
// dashboard strip and the settings analytics section — reads through these
// four functions:
//
//   * `getViewStats` — windowed totals, a zero-filled daily series, and the
//     referrer / country / page breakdowns.
//   * `getRecentViews` — the newest-first timeline, with resolved contacts.
//   * `getTopReferrers` — the cheap single-query referrer ranking the
//     dashboard strip uses without paying for the full stats payload.
//   * `getViewerContactMatches` — views attributed to known contacts via a
//     signed `?v=` link, newest first.
//   * `getViewsOverview` — the composition all three surfaces share
//     (`{ stats, recent, matches }`), so the CLI, the API and the dashboard
//     can never disagree.
//
// Privacy rules, enforced here rather than trusted to callers:
//
//   * Bots (`is_bot`) and owner views (`is_owner_view`) are EXCLUDED unless
//     the caller explicitly opts in — and the excluded counts are always
//     reported alongside, so "0 views" never silently hides "400 bot hits".
//   * Uniqueness is `COUNT(DISTINCT COALESCE(viewer_fingerprint, viewer_ip,
//     session_id))`: the fingerprint when the beacon could compute one, the
//     IP hash for minimal-mode (DNT) rows that deliberately have none, the
//     per-view session tag when there is no IP at all (each such view is
//     trivially unique). Nothing here can correlate across days — the
//     hashes rotate daily by construction (Phase 1).
//   * `days` is capped at 90, the raw-view retention window: asking for more
//     would silently under-report purged history, so it is a validation
//     error instead.
//   * Views stamped in the future (clock skew, hand-inserted fixtures) are
//     outside every window — the window is `[since, now]`, closed on both
//     ends.
//   * Resolved contacts join through live contacts only (`deleted_at IS
//     NULL`): a view attributed to a since-deleted contact renders
//     unattributed rather than resurrecting a name the owner deleted.
//
// Dialect notes: `viewed_at` is ISO-8601 text on BOTH dialects, so day
// bucketing is a portable `substr(viewed_at, 1, 10)`; booleans compare with
// `= true` (SQLite treats `true` as 1, Postgres natively). Referrer grouping
// needs host extraction, which SQL cannot do portably — so the queries group
// by the stored `scheme://host/path` value and the folding to domains
// happens in JS (`foldReferrerHosts`).
import { sql, type SQL } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { rawAll } from '../search/indexer';

type Conn = SqliteConn | PgConn;

export type ViewsErrorCode = 'invalid_input' | 'not_found' | 'conflict';

export class ViewsError extends Error {
  readonly code: ViewsErrorCode;
  constructor(code: ViewsErrorCode, message: string) {
    super(message);
    this.name = 'ViewsError';
    this.code = code;
  }
}

/** Raw views older than this are purged (Phase 1 retention) — the max window. */
export const VIEWS_MAX_DAYS = 90;
/** Default window: the last 30 days. */
export const VIEWS_DEFAULT_DAYS = 30;
/** Default breakdown / timeline length. */
export const VIEWS_DEFAULT_LIMIT = 10;
/** Hard cap for breakdown lists (the API clamps to less). */
export const VIEWS_MAX_LIMIT = 50;
/** Hard cap for timeline pagination. */
export const VIEWS_MAX_TIMELINE_LIMIT = 100;

export interface ViewStatsOptions {
  /** Window in days, 1–90. Default 30. */
  days?: number;
  /** Max rows per breakdown list, 1–50. Default 10. */
  limit?: number;
  /** Include `is_bot` rows in the counts. Default false. */
  includeBots?: boolean;
  /** Include `is_owner_view` rows in the counts. Default false. */
  includeOwnerViews?: boolean;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
}

export interface RecentViewsOptions extends ViewStatsOptions {
  /** Timeline offset for pagination. Default 0. */
  offset?: number;
}

export interface ViewerContactMatchesOptions {
  /** Window in days, 1–90. Default 30. */
  days?: number;
  /** Max matches, 1–50. Default 10. */
  limit?: number;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
}

export interface TopReferrersOptions {
  /** Window in days, 1–90. Default 30. */
  days?: number;
  /** Max referrers, 1–50. Default 10. */
  limit?: number;
  /** Include `is_bot` rows. Default false. */
  includeBots?: boolean;
  /** Include `is_owner_view` rows. Default false. */
  includeOwnerViews?: boolean;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
}

export interface ViewDayPoint {
  /** UTC `YYYY-MM-DD`. */
  date: string;
  views: number;
  unique: number;
}

export interface ViewCount {
  value: string;
  count: number;
  /** count / windowed views, 0 when empty. */
  share: number;
}

export interface ViewStats {
  window: { days: number; since: string; until: string };
  totals: {
    /** Views inside the window after bot/owner filtering. */
    views: number;
    /** Distinct viewers (fingerprint → IP hash → session fallback). */
    uniqueViewers: number;
    /** Views attributed to a live contact via a signed `?v=` link. */
    resolvedContacts: number;
    /** Mean `duration_ms` over rows that reported one, else null. */
    avgDurationMs: number | null;
  };
  /** Rows the filters held back (always reported, even when 0). */
  excluded: { bots: number; ownerViews: number };
  filters: { includeBots: boolean; includeOwnerViews: boolean };
  /** One point per UTC day in the window, oldest first, zeroes filled. */
  series: ViewDayPoint[];
  byReferrer: ViewCount[];
  byCountry: ViewCount[];
  byPage: ViewCount[];
}

export interface RecentViewContact {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
}

export interface RecentView {
  id: string;
  viewedAt: string;
  viewedPage: string;
  referrer: string | null;
  country: string | null;
  city: string | null;
  durationMs: number | null;
  isBot: boolean;
  isOwnerView: boolean;
  /** Live contact only; null when unresolved or since deleted. */
  resolvedContact: RecentViewContact | null;
}

export interface RecentViewsResult {
  views: RecentView[];
  total: number;
  limit: number;
  offset: number;
}

export interface ViewerContactMatch {
  viewId: string;
  viewedAt: string;
  viewedPage: string;
  referrer: string | null;
  contact: RecentViewContact;
}

export interface ViewerContactMatchesResult {
  matches: ViewerContactMatch[];
  total: number;
}

/** Everything the surfaces render, composed once so they cannot disagree. */
export interface ViewsOverview {
  stats: ViewStats;
  recent: RecentViewsResult;
  matches: ViewerContactMatchesResult;
}

// ── validation ────────────────────────────────────────────────────────────

function checkDays(days: number | undefined, fallback: number): number {
  const value = days ?? fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > VIEWS_MAX_DAYS) {
    throw new ViewsError(
      'invalid_input',
      `days must be an integer between 1 and ${VIEWS_MAX_DAYS}, got ${String(days)}.`,
    );
  }
  return value;
}

function checkLimit(limit: number | undefined, fallback: number, max: number, what: string): number {
  const value = limit ?? fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ViewsError(
      'invalid_input',
      `${what} must be an integer between 1 and ${max}, got ${String(limit)}.`,
    );
  }
  return value;
}

function checkOffset(offset: number | undefined): number {
  const value = offset ?? 0;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ViewsError('invalid_input', `offset must be a non-negative integer, got ${String(offset)}.`);
  }
  return value;
}

// ── shared SQL fragments ──────────────────────────────────────────────────

interface WindowClause {
  clause: SQL;
  sinceIso: string;
  untilIso: string;
}

/**
 * The window predicate: `viewed_at` inside `[since, now]`, plus the bot/owner
 * filters unless opted in. Every stats query shares it, so the totals, the
 * series and the breakdowns always describe the same set of rows.
 */
function windowClause(
  sinceIso: string,
  untilIso: string,
  opts: { includeBots?: boolean; includeOwnerViews?: boolean },
): SQL {
  const parts: SQL[] = [sql`viewed_at >= ${sinceIso} AND viewed_at <= ${untilIso}`];
  if (!opts.includeBots) parts.push(sql`is_bot = false`);
  if (!opts.includeOwnerViews) parts.push(sql`is_owner_view = false`);
  return sql.join(parts, sql` AND `);
}

function windowFor(now: Date, days: number): WindowClause {
  const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  const untilIso = now.toISOString();
  // Clause is assembled by callers via windowClause(); this only carries time.
  return { clause: sql`1 = 1`, sinceIso, untilIso };
}

/** The uniqueness expression: fingerprint → IP hash → per-view session tag. */
const UNIQUE_VIEWER = sql`COALESCE(viewer_fingerprint, viewer_ip, session_id)`;

// ── referrer folding ──────────────────────────────────────────────────────

/**
 * Fold stored `scheme://host/path` referrers to their host: the producer
 * stores the path (useful on the timeline), but the breakdown answers "which
 * sites send me readers". Unparseable values (hand-inserted, pre-Phase-2
 * rows) survive as their own bucket rather than vanishing.
 */
export function foldReferrerHosts(rows: Array<{ referrer: string | null; count: number }>): Map<string, number> {
  const folded = new Map<string, number>();
  for (const row of rows) {
    if (row.referrer === null) {
      folded.set('(direct)', (folded.get('(direct)') ?? 0) + row.count);
      continue;
    }
    let host = row.referrer;
    try {
      const parsed = new URL(row.referrer);
      if (parsed.host) host = parsed.host.toLowerCase();
    } catch {
      // Keep the raw value as its own bucket.
    }
    folded.set(host, (folded.get(host) ?? 0) + row.count);
  }
  return folded;
}

function toShares(folded: Map<string, number>, total: number, limit: number): ViewCount[] {
  return [...folded.entries()]
    .map(([value, count]) => ({ value, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, limit);
}

// ── getViewStats ──────────────────────────────────────────────────────────

export async function getViewStats(conn: Conn, options: ViewStatsOptions = {}): Promise<ViewStats> {
  const days = checkDays(options.days, VIEWS_DEFAULT_DAYS);
  const limit = checkLimit(options.limit, VIEWS_DEFAULT_LIMIT, VIEWS_MAX_LIMIT, 'limit');
  const includeBots = options.includeBots ?? false;
  const includeOwnerViews = options.includeOwnerViews ?? false;
  const now = options.now ?? new Date();
  const { sinceIso, untilIso } = windowFor(now, days);
  const where = windowClause(sinceIso, untilIso, { includeBots, includeOwnerViews });

  const totalsRows = await rawAll<{
    views: number;
    unique_viewers: number;
    resolved_contacts: number;
    avg_duration_ms: number | null;
  }>(
    conn,
    sql`SELECT COUNT(*) AS views,
               COUNT(DISTINCT ${UNIQUE_VIEWER}) AS unique_viewers,
               COUNT(DISTINCT resolved_contact) AS resolved_contacts,
               AVG(duration_ms) AS avg_duration_ms
        FROM profile_views
        WHERE ${where}`,
  );
  const totals = totalsRows[0] ?? {
    views: 0,
    unique_viewers: 0,
    resolved_contacts: 0,
    avg_duration_ms: null,
  };

  // What the filters held back — counted over the same window, unfiltered.
  const excludedRows = await rawAll<{ bots: number; owner_views: number }>(
    conn,
    sql`SELECT COUNT(*) FILTER (WHERE is_bot = true) AS bots,
               COUNT(*) FILTER (WHERE is_owner_view = true) AS owner_views
        FROM profile_views
        WHERE viewed_at >= ${sinceIso} AND viewed_at <= ${untilIso}`,
  );
  const excludedRaw = excludedRows[0] ?? { bots: 0, owner_views: 0 };

  const seriesRows = await rawAll<{ day: string; views: number; unique_viewers: number }>(
    conn,
    sql`SELECT substr(viewed_at, 1, 10) AS day,
               COUNT(*) AS views,
               COUNT(DISTINCT ${UNIQUE_VIEWER}) AS unique_viewers
        FROM profile_views
        WHERE ${where}
        GROUP BY day
        ORDER BY day`,
  );

  const referrerRows = await rawAll<{ referrer: string | null; count: number }>(
    conn,
    sql`SELECT referrer, COUNT(*) AS count
        FROM profile_views
        WHERE ${where}
        GROUP BY referrer`,
  );
  const countryRows = await rawAll<{ country: string | null; count: number }>(
    conn,
    sql`SELECT country, COUNT(*) AS count
        FROM profile_views
        WHERE ${where}
        GROUP BY country`,
  );
  const pageRows = await rawAll<{ viewed_page: string; count: number }>(
    conn,
    sql`SELECT viewed_page, COUNT(*) AS count
        FROM profile_views
        WHERE ${where}
        GROUP BY viewed_page`,
  );

  // Zero-fill every UTC day in the window so charts never skip quiet days.
  // (COUNT arrives as a string on Postgres — normalize everything here.)
  const byDay = new Map(
    seriesRows.map((r) => [r.day, { views: Number(r.views), unique: Number(r.unique_viewers) }]),
  );
  const series: ViewDayPoint[] = [];
  const startDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(startDay.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const row = byDay.get(date);
    series.push({ date, views: row?.views ?? 0, unique: row?.unique ?? 0 });
  }

  const views = Number(totals.views);
  const countryFolded = new Map<string, number>();
  for (const row of countryRows) {
    const key = row.country && row.country.trim() !== '' ? row.country : '(unknown)';
    countryFolded.set(key, (countryFolded.get(key) ?? 0) + Number(row.count));
  }
  const pageFolded = new Map<string, number>();
  for (const row of pageRows) {
    pageFolded.set(row.viewed_page, (pageFolded.get(row.viewed_page) ?? 0) + Number(row.count));
  }

  return {
    window: { days, since: sinceIso, until: untilIso },
    totals: {
      views,
      uniqueViewers: Number(totals.unique_viewers),
      resolvedContacts: Number(totals.resolved_contacts),
      avgDurationMs:
        totals.avg_duration_ms === null || totals.avg_duration_ms === undefined
          ? null
          : Math.round(Number(totals.avg_duration_ms)),
    },
    excluded: {
      bots: includeBots ? 0 : Number(excludedRaw.bots),
      ownerViews: includeOwnerViews ? 0 : Number(excludedRaw.owner_views),
    },
    filters: { includeBots, includeOwnerViews },
    series,
    byReferrer: toShares(foldReferrerHosts(referrerRows.map((r) => ({ ...r, count: Number(r.count) }))), views, limit),
    byCountry: toShares(countryFolded, views, limit),
    byPage: toShares(pageFolded, views, limit),
  };
}

// ── getRecentViews ────────────────────────────────────────────────────────

interface RecentRow extends Record<string, unknown> {
  id: string;
  viewed_at: string;
  viewed_page: string;
  referrer: string | null;
  country: string | null;
  city: string | null;
  duration_ms: number | null;
  is_bot: boolean | number;
  is_owner_view: boolean | number;
  contact_id: string | null;
  contact_name: string | null;
  contact_company: string | null;
  contact_role: string | null;
}

function toRecentView(row: RecentRow): RecentView {
  return {
    id: row.id,
    viewedAt: row.viewed_at,
    viewedPage: row.viewed_page,
    referrer: row.referrer,
    country: row.country,
    city: row.city,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    isBot: Boolean(row.is_bot),
    isOwnerView: Boolean(row.is_owner_view),
    resolvedContact:
      row.contact_id !== null && row.contact_name !== null
        ? {
            id: row.contact_id,
            fullName: row.contact_name,
            company: row.contact_company,
            role: row.contact_role,
          }
        : null,
  };
}

export async function getRecentViews(conn: Conn, options: RecentViewsOptions = {}): Promise<RecentViewsResult> {
  const days = checkDays(options.days, VIEWS_DEFAULT_DAYS);
  const limit = checkLimit(options.limit, VIEWS_DEFAULT_LIMIT, VIEWS_MAX_TIMELINE_LIMIT, 'limit');
  const offset = checkOffset(options.offset);
  const includeBots = options.includeBots ?? false;
  const includeOwnerViews = options.includeOwnerViews ?? false;
  const now = options.now ?? new Date();
  const { sinceIso, untilIso } = windowFor(now, days);

  // Filters qualify the profile_views alias explicitly — the join must not
  // change which rows qualify, only decorate them.
  const parts: SQL[] = [sql`v.viewed_at >= ${sinceIso} AND v.viewed_at <= ${untilIso}`];
  if (!includeBots) parts.push(sql`v.is_bot = false`);
  if (!includeOwnerViews) parts.push(sql`v.is_owner_view = false`);
  const where = sql.join(parts, sql` AND `);

  const totalRows = await rawAll<{ total: number }>(
    conn,
    sql`SELECT COUNT(*) AS total FROM profile_views v WHERE ${where}`,
  );
  const rows = await rawAll<RecentRow>(
    conn,
    sql`SELECT v.id, v.viewed_at, v.viewed_page, v.referrer, v.country, v.city,
               v.duration_ms, v.is_bot, v.is_owner_view,
               c.id AS contact_id, c.full_name AS contact_name,
               c.company AS contact_company, c.role AS contact_role
        FROM profile_views v
        LEFT JOIN contacts c ON c.id = v.resolved_contact AND c.deleted_at IS NULL
        WHERE ${where}
        ORDER BY v.viewed_at DESC, v.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
  );
  return {
    views: rows.map(toRecentView),
    total: Number(totalRows[0]?.total ?? 0),
    limit,
    offset,
  };
}

// ── getTopReferrers ───────────────────────────────────────────────────────

export async function getTopReferrers(conn: Conn, options: TopReferrersOptions = {}): Promise<ViewCount[]> {
  const days = checkDays(options.days, VIEWS_DEFAULT_DAYS);
  const limit = checkLimit(options.limit, VIEWS_DEFAULT_LIMIT, VIEWS_MAX_LIMIT, 'limit');
  const now = options.now ?? new Date();
  const { sinceIso, untilIso } = windowFor(now, days);
  const where = windowClause(sinceIso, untilIso, options);
  const rows = await rawAll<{ referrer: string | null; count: number }>(
    conn,
    sql`SELECT referrer, COUNT(*) AS count
        FROM profile_views
        WHERE ${where}
        GROUP BY referrer`,
  );
  const folded = foldReferrerHosts(rows.map((r) => ({ ...r, count: Number(r.count) })));
  const total = [...folded.values()].reduce((a, b) => a + b, 0);
  return toShares(folded, total, limit);
}

// ── getViewerContactMatches ───────────────────────────────────────────────

interface MatchRow extends Record<string, unknown> {
  view_id: string;
  viewed_at: string;
  viewed_page: string;
  referrer: string | null;
  contact_id: string;
  contact_name: string;
  contact_company: string | null;
  contact_role: string | null;
}

export async function getViewerContactMatches(
  conn: Conn,
  options: ViewerContactMatchesOptions = {},
): Promise<ViewerContactMatchesResult> {
  const days = checkDays(options.days, VIEWS_DEFAULT_DAYS);
  const limit = checkLimit(options.limit, VIEWS_DEFAULT_LIMIT, VIEWS_MAX_LIMIT, 'limit');
  const now = options.now ?? new Date();
  const { sinceIso, untilIso } = windowFor(now, days);

  // Known visitors only: an inner join through live contacts. Bots and owner
  // views stay excluded even here — a crawler following a signed link is not
  // "your contact viewed your card".
  const where = sql`v.viewed_at >= ${sinceIso} AND v.viewed_at <= ${untilIso}
    AND v.is_bot = false AND v.is_owner_view = false
    AND v.resolved_contact IS NOT NULL`;
  const totalRows = await rawAll<{ total: number }>(
    conn,
    sql`SELECT COUNT(*) AS total
        FROM profile_views v
        JOIN contacts c ON c.id = v.resolved_contact AND c.deleted_at IS NULL
        WHERE ${where}`,
  );
  const rows = await rawAll<MatchRow>(
    conn,
    sql`SELECT v.id AS view_id, v.viewed_at, v.viewed_page, v.referrer,
               c.id AS contact_id, c.full_name AS contact_name,
               c.company AS contact_company, c.role AS contact_role
        FROM profile_views v
        JOIN contacts c ON c.id = v.resolved_contact AND c.deleted_at IS NULL
        WHERE ${where}
        ORDER BY v.viewed_at DESC, v.id DESC
        LIMIT ${limit}`,
  );
  return {
    matches: rows.map((r) => ({
      viewId: r.view_id,
      viewedAt: r.viewed_at,
      viewedPage: r.viewed_page,
      referrer: r.referrer,
      contact: {
        id: r.contact_id,
        fullName: r.contact_name,
        company: r.contact_company,
        role: r.contact_role,
      },
    })),
    total: Number(totalRows[0]?.total ?? 0),
  };
}

// ── getViewsOverview ──────────────────────────────────────────────────────

export interface ViewsOverviewOptions {
  days?: number;
  limit?: number;
  /** Timeline offset for the recent-views page. Default 0. */
  offset?: number;
  includeBots?: boolean;
  includeOwnerViews?: boolean;
  now?: Date;
}

/**
 * The one composition every surface shares: windowed stats, the recent
 * timeline, and the known-visitor matches. `limit` sizes the breakdowns,
 * the timeline page and the match list together — callers that need
 * different sizes call the pieces directly.
 */
export async function getViewsOverview(conn: Conn, options: ViewsOverviewOptions = {}): Promise<ViewsOverview> {
  const [stats, recent, matches] = await Promise.all([
    getViewStats(conn, options),
    getRecentViews(conn, options),
    getViewerContactMatches(conn, options),
  ]);
  return { stats, recent, matches };
}
