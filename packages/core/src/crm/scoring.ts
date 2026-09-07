// packages/core/src/crm/scoring.ts
//
// Per-contact relationship scoring — the formula from the "DB & Pipeline
// Deep Dive" §2.6, which Phase 3 deferred until interactions had a producer.
//
//   recency   40% — 100 − 0.5 per day since the last interaction
//   frequency 25% — 15 points per interaction in the last 90 days (capped)
//   depth     20% — inbound/outbound balance (two-way relationships score)
//   richness  15% — 25 points per distinct interaction type (capped at 4)
//
// The blueprint's score is 0–100; the database column stores 0–1 because
// every existing consumer (search `minScore`, analytics
// `avgRelationshipScore`, dashboard, dormant-ties ordering) was built against
// that scale. `relationshipScoreColumn` is the single normalization point.

import { daysSince } from './types';

/** The interaction fields the score needs — nothing more is loaded. */
export interface ScoredInteraction {
  type: string;
  direction: string | null;
  occurredAt: string;
}

export const SCORE_WEIGHTS = {
  recency: 0.4,
  frequency: 0.25,
  depth: 0.2,
  richness: 0.15,
} as const;

/** Recency decay: half a point per day since the last interaction. */
export const RECENCY_DECAY_PER_DAY = 0.5;
/** Frequency: points per interaction inside the window, and the window itself. */
export const FREQUENCY_POINTS_PER_INTERACTION = 15;
export const FREQUENCY_WINDOW_DAYS = 90;
/** Richness: points per distinct interaction type (4 types saturate). */
export const RICHNESS_POINTS_PER_TYPE = 25;

/**
 * Compute the 0–100 relationship score over a contact's interactions.
 * Pure function of (history, now) — no ordering assumptions: the last
 * interaction is derived by max, not by trusting row order.
 */
export function computeRelationshipScore(
  interactions: ScoredInteraction[],
  now: Date = new Date()
): number {
  if (interactions.length === 0) return 0;

  let score = 0;

  // Factor 1: recency (40%)
  let lastIso: string | null = null;
  for (const i of interactions) {
    if (lastIso === null || i.occurredAt > lastIso) lastIso = i.occurredAt;
  }
  if (lastIso !== null) {
    const recencyScore = Math.max(0, 100 - daysSince(now, lastIso) * RECENCY_DECAY_PER_DAY);
    score += recencyScore * SCORE_WEIGHTS.recency;
  }

  // Factor 2: frequency (25%) — interactions within the last 90 days
  const recent = interactions.filter(
    (i) => daysSince(now, i.occurredAt) <= FREQUENCY_WINDOW_DAYS
  ).length;
  score +=
    Math.min(100, recent * FREQUENCY_POINTS_PER_INTERACTION) * SCORE_WEIGHTS.frequency;

  // Factor 3: depth (20%) — bidirectional communication is stronger
  let outbound = 0;
  let inbound = 0;
  for (const i of interactions) {
    if (i.direction === 'outbound') outbound += 1;
    else if (i.direction === 'inbound') inbound += 1;
  }
  const ratio = Math.min(outbound, inbound) / Math.max(outbound, inbound, 1);
  score += ratio * 100 * SCORE_WEIGHTS.depth;

  // Factor 4: richness (15%) — diverse interaction types
  const uniqueTypes = new Set(interactions.map((i) => i.type)).size;
  score += Math.min(100, uniqueTypes * RICHNESS_POINTS_PER_TYPE) * SCORE_WEIGHTS.richness;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * The value stored in `contacts.relationship_score`: the 0–100 score
 * normalized to the 0–1 scale the rest of NetPro uses. Two decimals — the
 * source score is an integer, so this is exact.
 */
export function relationshipScoreColumn(
  interactions: ScoredInteraction[],
  now: Date = new Date()
): number {
  return computeRelationshipScore(interactions, now) / 100;
}
