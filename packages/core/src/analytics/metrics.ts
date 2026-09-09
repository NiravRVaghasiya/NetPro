// packages/core/src/analytics/metrics.ts
//
// Network-wide metrics and the composite network score.
//
// Compute strategy: ONE portable projection query over the non-deleted
// contacts (seven plain columns), then pure JS aggregation. Every metric in
// this phase — counts, entropy, growth buckets, clusters — derives from those
// rows, so the whole module shares a single ANSI-SQL read path and behaves
// identically on SQLite and Postgres with zero dialect branching beyond the
// thin executor. (The same pragmatism as Phase 2's facet queries; the
// denormalized aggregates in the blueprint's Stage 5 belong to the phase that
// introduces real data volume.)
import { and, isNull } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  daysAgoIso,
  resolveAnalyticsOptions,
  type AnalyticsOptions,
  type NetworkMetrics,
  type ScoreBreakdown,
  type ScoreFactor,
  type TopValue,
} from "./types";
import { workspacePredicate, type WorkspaceScope } from "../workspaces/scope";

/** The contacts columns analytics reads — the entire data footprint of this module. */
export interface ProjectedContact {
  id: string;
  company: string | null;
  industry: string | null;
  role: string | null;
  relationshipScore: number | null;
  lastInteraction: string | null;
  createdAt: string;
}

/**
 * Load the analytics projection: every non-deleted contact, seven columns.
 * Soft-deleted rows are always excluded (same rule as search). Drizzle's
 * typed builders need dialect-narrowed columns, so the identical select is
 * written per branch — the queries themselves are ANSI-portable.
 */
export async function projectContacts(
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<ProjectedContact[]> {
  if (conn.dialect === "sqlite") {
    const c = conn.schema.contacts;
    return conn.db
      .select({
        id: c.id,
        company: c.company,
        industry: c.industry,
        role: c.role,
        relationshipScore: c.relationshipScore,
        lastInteraction: c.lastInteraction,
        createdAt: c.createdAt,
      })
      .from(c)
      .where(
        and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)),
      );
  }

  const c = conn.schema.contacts;
  return conn.db
    .select({
      id: c.id,
      company: c.company,
      industry: c.industry,
      role: c.role,
      relationshipScore: c.relationshipScore,
      lastInteraction: c.lastInteraction,
      createdAt: c.createdAt,
    })
    .from(c)
    .where(and(isNull(c.deletedAt), workspacePredicate(scope, c.workspaceId)));
}

/** A contact's last known touchpoint: its interaction date, else when the relationship was acquired. */
export function lastTouchOf(row: ProjectedContact): string {
  return row.lastInteraction ?? row.createdAt;
}

/** Non-empty, lowercased, trimmed values of a projected field. */
export function normalizedValues(
  rows: ProjectedContact[],
  field: "company" | "industry" | "role",
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const v = row[field];
    if (v !== null && v !== undefined) {
      const t = v.trim().toLowerCase();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

/** Count occurrences of each value, sorted by count desc then value asc. */
export function countValues(
  values: string[],
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

/** Shannon entropy in nats over a list of counts (0 for empty/single-valued input). */
export function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h;
}

/** exp(entropy): the "effective number of categories" — 1 when uniform-single, N when spread over N equal buckets. */
export function effectiveCategories(counts: number[]): number {
  return Math.exp(shannonEntropy(counts));
}

/**
 * Compute network metrics over the non-deleted contacts.
 *
 * Dormancy note: a contact with no recorded interaction is measured from its
 * connection date (`createdAt`) — never-interacted is at least as stale as
 * acquisition. Activity, by contrast, requires a real interaction date.
 */
export async function computeNetworkMetrics(
  conn: SqliteConn | PgConn,
  options: AnalyticsOptions = {},
): Promise<NetworkMetrics> {
  const { dormantDays, activeDays, now } = resolveAnalyticsOptions(options);
  const rows = await projectContacts(conn, options.scope);

  const activeCutoff = daysAgoIso(now, activeDays);
  const dormantCutoff = daysAgoIso(now, dormantDays);

  let active = 0;
  let dormant = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const row of rows) {
    if (row.lastInteraction !== null && row.lastInteraction >= activeCutoff) {
      active += 1;
    }
    if (lastTouchOf(row) < dormantCutoff) {
      dormant += 1;
    }
    if (typeof row.relationshipScore === "number") {
      scoreSum += row.relationshipScore;
      scoreCount += 1;
    }
  }

  const total = rows.length;

  // Diversity: industries when there's signal (>=2 distinct), else companies.
  // LinkedIn's export carries no industry at all — it fills in via
  // enrichment — so the fallback keeps the number meaningful pre-enrichment.
  const industryCounts = countValues(normalizedValues(rows, "industry"));
  const companyCounts = countValues(normalizedValues(rows, "company"));
  const useIndustry = industryCounts.length >= 2;
  const diversityCounts = useIndustry
    ? industryCounts.map((c) => c.count)
    : companyCounts.map((c) => c.count);

  return {
    totalContacts: total,
    activeConnections: active,
    dormantConnections: dormant,
    activeRate: total > 0 ? active / total : 0,
    dormantRate: total > 0 ? dormant / total : 0,
    avgRelationshipScore:
      scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 1000) / 1000 : null,
    diversityEffective:
      diversityCounts.length > 0
        ? Math.round(effectiveCategories(diversityCounts) * 100) / 100
        : 0,
    diversityField: useIndustry ? "industry" : "company",
    companiesDistinct: companyCounts.length,
    industriesDistinct: industryCounts.length,
  };
}

/**
 * Full marks on diversity once the network spans this many effective
 * categories. 8 industries ≈ "genuinely varied network".
 */
export const DIVERSITY_TARGET = 8;
/** Full growth marks at 20+ new contacts in the last 30 days (blueprint: "20/mo = max"). */
export const GROWTH_TARGET_PER_30D = 20;
/** Full size marks at 500 contacts (blueprint: `(total / 500) * 100`). */
export const SIZE_TARGET = 500;

/**
 * The blueprint's five score factors include `structure` (cluster bridges),
 * which needs the `edges` table — nothing populates edges yet, so its 0.20
 * weight is redistributed over the four measurable factors:
 * activity 0.35, diversity 0.30, size 0.20, growth 0.15. When the phase that
 * produces edges lands, structure joins at the blueprint's 0.20 and these are
 * renormalized back down.
 */
export const SCORE_WEIGHTS = {
  activity: 0.35,
  diversity: 0.3,
  size: 0.2,
  growth: 0.15,
} as const;

/** Inputs for the composite score (all measurable without edges). */
export interface NetworkScoreInputs {
  totalContacts: number;
  /** 0–1. */
  activeRate: number;
  /** Effective category count (see {@link effectiveCategories}). */
  diversityEffective: number;
  /** New contacts in the last 30 days. */
  newLast30Days: number;
}

/**
 * Composite 0–100 network health score with the per-factor breakdown.
 * Pure — the caller supplies the numbers so the score is trivially testable
 * and identical on every surface.
 */
export function computeNetworkScore(
  inputs: NetworkScoreInputs,
): ScoreBreakdown {
  const sizeValue = Math.min(100, (inputs.totalContacts / SIZE_TARGET) * 100);
  const activityValue = Math.min(100, inputs.activeRate * 100);
  const diversityValue = Math.min(
    100,
    (inputs.diversityEffective / DIVERSITY_TARGET) * 100,
  );
  const growthValue = Math.min(
    100,
    (inputs.newLast30Days / GROWTH_TARGET_PER_30D) * 100,
  );

  const factors: ScoreFactor[] = [
    {
      key: "activity",
      value: round1(activityValue),
      weight: SCORE_WEIGHTS.activity,
    },
    {
      key: "diversity",
      value: round1(diversityValue),
      weight: SCORE_WEIGHTS.diversity,
    },
    { key: "size", value: round1(sizeValue), weight: SCORE_WEIGHTS.size },
    { key: "growth", value: round1(growthValue), weight: SCORE_WEIGHTS.growth },
  ];

  const weighted = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
  return { score: Math.round(Math.min(100, Math.max(0, weighted))), factors };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Top-N non-empty values of a field with shares of `total`. */
export function topValues(
  rows: ProjectedContact[],
  field: "company" | "industry",
  total: number,
  limit: number,
): TopValue[] {
  return countValues(normalizedValues(rows, field))
    .slice(0, limit)
    .map(({ value, count }) => ({
      value,
      count,
      share: total > 0 ? count / total : 0,
    }));
}
