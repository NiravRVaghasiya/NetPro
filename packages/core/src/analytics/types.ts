// packages/core/src/analytics/types.ts
//
// Shared types and option normalization for the analytics engine.
//
// Every core analytics function takes the same options shape and an
// injectable `now` clock: growth windows, dormancy cutoffs, and month
// buckets are all relative to "now", and injecting it keeps tests
// deterministic without frozen timers.
import type { GraphAnalysisOptions } from "../graph/analysis";
import type { NetworkGraph } from "../graph/network";
import type { ContentOverview } from "../content/repository";
import type { ViewsOverview, ViewsOverviewOptions } from "../views/analytics";
import type { WorkspaceScope } from "../workspaces/scope";

/** Options accepted by every analytics function. All fields optional. */
export interface AnalyticsOptions {
  /** Dormancy window in days (default 90). */
  dormantDays?: number;
  /** "Active" window in days — an interaction within this window counts as active (default 30). */
  activeDays?: number;
  /** Growth window in months, including the current partial month (default 12, max 60). */
  growthMonths?: number;
  /** Max rows for list-shaped sections: dormant ties, clusters (default 10, max 100). */
  limit?: number;
  /**
   * Include the v2.0 graph-analytics section (`NetworkGraph`) in the
   * overview. Default true; the dashboard relies on it, `?graph=0` opts out.
   */
  includeGraph?: boolean;
  /** Filters forwarded to the graph analytics (status/relation/confidence/depth). */
  graph?: GraphAnalysisOptions;
  /**
   * Include the v2.5 viewer-analytics section (`ViewsOverview`) in the
   * overview. Default true; the dashboard relies on it, `?views=0` opts out.
   */
  includeViews?: boolean;
  /** Window forwarded to the viewer analytics (days/limit, default 30/5). */
  views?: ViewsOverviewOptions;
  /**
   * Include the v2.5 content-tracker section (`ContentOverview`, all-time)
   * in the overview. Default true; the dashboard relies on it, `?content=0`
   * opts out to keep the payload small (v2.5 Phase 6).
   */
  includeContent?: boolean;
  /**
   * Injected clock for deterministic behavior/tests. Defaults to `new Date()`.
   * All window math uses UTC.
   */
  now?: Date;
  /**
   * v3.0 Phase 2 — workspace scope for every query this module runs.
   * Absent = bootstrap workspace (single-owner compatibility guarantee).
   */
  scope?: WorkspaceScope;
}

export interface ResolvedAnalyticsOptions {
  dormantDays: number;
  activeDays: number;
  growthMonths: number;
  limit: number;
  now: Date;
}

export function resolveAnalyticsOptions(
  opts: AnalyticsOptions = {},
): ResolvedAnalyticsOptions {
  const dormantDays = bound(opts.dormantDays ?? 90, 1);
  const activeDays = bound(opts.activeDays ?? 30, 1);
  const growthMonths = Math.min(Math.max(opts.growthMonths ?? 12, 1), 60);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const now = opts.now ?? new Date();
  return { dormantDays, activeDays, growthMonths, limit, now };
}

function bound(value: number, min: number): number {
  return Math.max(value, min);
}

/** ISO timestamp `days` before `now`. */
export function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Whole days between `from` (ISO string) and `now`, floored at 0. */
export function daysBetween(now: Date, from: string): number {
  const ms = now.getTime() - Date.parse(from);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

/** UTC `YYYY-MM` key for a date. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Aggregate metrics over the whole (non-deleted) network. */
export interface NetworkMetrics {
  totalContacts: number;
  /** Had a recorded interaction within the active window. */
  activeConnections: number;
  /** No known interaction within the dormant window (never-interacted counts from its connection date). */
  dormantConnections: number;
  /** activeConnections / totalContacts, 0 when empty. */
  activeRate: number;
  /** dormantConnections / totalContacts, 0 when empty. */
  dormantRate: number;
  /** Mean non-null relationship score (0–1 scale), null when no scores exist. */
  avgRelationshipScore: number | null;
  /**
   * Diversity as an effective category count: exp(Shannon entropy) over
   * industries — or companies when fewer than 2 distinct industries exist.
   * 1.0 means "everything the same", N means "spread across N equally
   * common buckets".
   */
  diversityEffective: number;
  /** Which field the diversity number was computed over. */
  diversityField: "industry" | "company";
  companiesDistinct: number;
  industriesDistinct: number;
}

/** One scored factor of the composite network score. */
export interface ScoreFactor {
  key: "size" | "activity" | "diversity" | "growth";
  value: number;
  weight: number;
}

/** Composite 0–100 network health score plus the factors behind it. */
export interface ScoreBreakdown {
  /** 0–100. */
  score: number;
  factors: ScoreFactor[];
}

/** One month of network growth. */
export interface GrowthPoint {
  /** UTC `YYYY-MM`. */
  month: string;
  /** Contacts whose connection date falls in this month. */
  count: number;
  /** Running total including everything older than the window's first month. */
  cumulative: number;
}

export interface GrowthSummary {
  series: GrowthPoint[];
  /** New contacts in the 30 days before `now`. */
  last30: number;
  /** New contacts in the 30 days before that. */
  prior30: number;
  /** (last30 − prior30) / prior30 × 100, null when prior30 is 0. */
  ratePct: number | null;
}

export interface TopValue {
  value: string;
  count: number;
  /** count / totalContacts, 0 when empty. */
  share: number;
}

/** An attribute-based network cluster (contacts sharing a normalized company). */
export interface ClusterInfo {
  /** Normalized group key, e.g. `stripe`. */
  key: string;
  /** Most common original spelling in the group, e.g. `Stripe`. */
  label: string;
  size: number;
  /** size / totalContacts, 0 when empty. */
  share: number;
  topRoles: TopValue[];
}

/** A contact due for a reconnect, as surfaced by the dormant-ties list. */
export interface DormantContact {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  /** The contact's lastInteraction when present, else its connection date. */
  lastInteraction: string | null;
  /** Whole days since `lastInteraction` (or the fallback date). */
  daysSince: number;
}

/** Everything `/dashboard` and `netpro analyze` render, in one payload. */
export interface NetworkOverview {
  metrics: NetworkMetrics;
  score: ScoreBreakdown;
  growth: GrowthSummary;
  topCompanies: TopValue[];
  topIndustries: TopValue[];
  clusters: ClusterInfo[];
  dormant: DormantContact[];
  /**
   * v2.0 graph analytics (communities, centrality, components, warm-intro
   * candidates) — present unless `includeGraph: false`. Attribute clusters
   * above stay the fallback when no confirmed edges exist yet.
   */
  graph?: NetworkGraph;
  /**
   * v2.5 viewer analytics (windowed stats, recent timeline, known-visitor
   * matches) — present unless `includeViews: false`. The dashboard renders
   * its "Profile views" strip from this; the settings page calls
   * `getViewsOverview` directly for its wider window controls.
   */
  views?: ViewsOverview;
  /**
   * v2.5 content-tracker overview (all-time totals, top pieces by
   * latest-known views, platform breakdown) — present unless
   * `includeContent: false` (v2.5 Phase 6 folded it into the shared
   * payload so the dashboard's "Content" strip reads the same source as
   * `GET /api/analytics`).
   */
  content?: ContentOverview;
  generatedAt: string;
}
