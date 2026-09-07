import { describe, expect, it } from 'vitest';
import {
  computeRelationshipScore,
  relationshipScoreColumn,
  type ScoredInteraction,
} from './scoring';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

function interaction(
  type: string,
  direction: string | null,
  daysAgo: number
): ScoredInteraction {
  return { type, direction, occurredAt: iso(daysAgo) };
}

describe('computeRelationshipScore (Deep Dive §2.6 formula)', () => {
  it('is 0 with no interactions', () => {
    expect(computeRelationshipScore([], NOW)).toBe(0);
  });

  it('scores a single outbound email today: 40 recency + 3.75 frequency + 0 depth + 3.75 richness = 48', () => {
    const score = computeRelationshipScore([interaction('email_sent', 'outbound', 0)], NOW);
    expect(score).toBe(48);
    expect(relationshipScoreColumn([interaction('email_sent', 'outbound', 0)], NOW)).toBe(0.48);
  });

  it('rewards two-way exchange: depth factor adds 20', () => {
    const history = [
      interaction('email_sent', 'outbound', 0),
      interaction('email_received', 'inbound', 0),
    ];
    // 40 recency + 7.5 frequency (2×15×0.25) + 20 depth + 7.5 richness (2×25×0.15)
    expect(computeRelationshipScore(history, NOW)).toBe(75);
  });

  it('decays recency at 0.5/day', () => {
    // 40 days ago: recency (100−20)×0.4=32, frequency 3.75, richness 3.75 → 39.5 → 40
    expect(computeRelationshipScore([interaction('note', null, 40)], NOW)).toBe(40);
    // 200 days ago: recency 0, frequency 0 (outside 90d), richness 3.75 → 4
    expect(computeRelationshipScore([interaction('note', null, 200)], NOW)).toBe(4);
  });

  it('caps frequency at 100 (≈7 interactions in 90 days)', () => {
    const history = Array.from({ length: 10 }, () => interaction('note', null, 0));
    // 40 + 25 (capped) + 0 + 3.75 = 68.75 → 69
    expect(computeRelationshipScore(history, NOW)).toBe(69);
  });

  it('caps richness at 4 distinct types and only counts the 90-day frequency window', () => {
    const history = [
      interaction('meeting', null, 100),
      interaction('call', null, 100),
      interaction('note', null, 100),
      interaction('email_sent', 'outbound', 100),
      interaction('intro_made', 'outbound', 100),
    ];
    // recency (100−50)×0.4=20, frequency 0, depth 0, richness 15 (capped) → 35
    expect(computeRelationshipScore(history, NOW)).toBe(35);
  });

  it('derives the last interaction by max occurredAt, not row order', () => {
    const unordered = [
      interaction('note', null, 30),
      interaction('meeting', null, 0),
      interaction('call', null, 60),
    ];
    const ordered = [
      interaction('meeting', null, 0),
      interaction('note', null, 30),
      interaction('call', null, 60),
    ];
    expect(computeRelationshipScore(unordered, NOW)).toBe(
      computeRelationshipScore(ordered, NOW)
    );
  });

  it('counts depth only for directional interactions; undirected ones neither help nor hurt the ratio', () => {
    const withNote = [
      interaction('email_sent', 'outbound', 0),
      interaction('email_received', 'inbound', 0),
      interaction('note', null, 0),
    ];
    // ratio stays 1.0: min(1,1)/max(1,1). 40 + 11.25 + 20 + 11.25 = 82.5 → 83
    expect(computeRelationshipScore(withNote, NOW)).toBe(83);
  });

  it('clamps to 0–100 and normalizes to the 0–1 column scale', () => {
    const history = [
      ...Array.from({ length: 8 }, (_, i) => interaction('email_sent', 'outbound', i)),
      ...Array.from({ length: 8 }, (_, i) => interaction('email_received', 'inbound', i)),
      interaction('meeting', null, 1),
      interaction('call', null, 2),
      interaction('note', null, 3),
      interaction('intro_made', 'outbound', 4),
    ];
    const score = computeRelationshipScore(history, NOW);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(relationshipScoreColumn(history, NOW)).toBeCloseTo(score / 100, 10);
  });
});
