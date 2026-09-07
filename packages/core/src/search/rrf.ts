// packages/core/src/search/rrf.ts
//
// Reciprocal Rank Fusion — the dialect-agnostic half of hybrid search.
//
// Each arm (portable substring, dialect-native full text, semantic vectors)
// produces its own ranked list of contact ids. Their scores are NOT
// comparable: FTS5 returns negative bm25, Postgres returns ts_rank in [0,1),
// cosine similarity is in [-1,1]. RRF throws the scores away and fuses on
// RANK alone, which is exactly why it is the standard choice here — it needs
// no per-arm calibration and cannot be skewed by one arm's score scale.
//
//     score(d) = Σ_arms weight_arm / (k + rank_arm(d))     (rank is 1-based)
//
// k=60 (Cormack, Clarke & Buettcher 2009) damps the top of each list so a
// document ranked #1 by one arm does not automatically beat a document ranked
// #2 by all three.
//
// Pure and synchronous: both dialects run the identical merge, and the unit
// tests check hand-computed values rather than "looks about right" ordering.
import { RRF_K } from "./types";

export interface RankedList {
  /** Arm label, echoed on the fused entry so callers can show provenance. */
  arm: string;
  /** Contact ids, best first. Duplicates are ignored (first occurrence wins). */
  ids: string[];
  /**
   * Relative influence of this arm. Defaults to 1. Weights are a deliberate
   * escape hatch (documented, tested) rather than a tuning knob users see.
   */
  weight?: number;
}

export interface FusedResult {
  id: string;
  score: number;
  /** 1-based rank in each arm that returned this id. */
  ranks: Record<string, number>;
  /** Arms that returned this id, in the order the lists were supplied. */
  arms: string[];
}

/**
 * Fuse ranked lists into one ordered result set.
 *
 * Ties break deterministically: higher score, then more contributing arms,
 * then best (lowest) single rank, then id ascending. Determinism matters —
 * pagination over a fused list is only coherent if the same query yields the
 * same order every time.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  k: number = RRF_K,
): FusedResult[] {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`reciprocalRankFusion: k must be a positive number, got ${k}`);
  }

  const merged = new Map<string, FusedResult>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (weight === 0) continue;
    let rank = 0;
    const seen = new Set<string>();
    for (const id of list.ids) {
      if (seen.has(id)) continue; // a duplicate must not double-count
      seen.add(id);
      rank += 1;
      const existing = merged.get(id);
      const contribution = weight / (k + rank);
      if (existing) {
        existing.score += contribution;
        existing.ranks[list.arm] = rank;
        existing.arms.push(list.arm);
      } else {
        merged.set(id, {
          id,
          score: contribution,
          ranks: { [list.arm]: rank },
          arms: [list.arm],
        });
      }
    }
  }

  return [...merged.values()].sort(compareFused);
}

function compareFused(a: FusedResult, b: FusedResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.arms.length !== a.arms.length) return b.arms.length - a.arms.length;
  const bestA = Math.min(...Object.values(a.ranks));
  const bestB = Math.min(...Object.values(b.ranks));
  if (bestA !== bestB) return bestA - bestB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
