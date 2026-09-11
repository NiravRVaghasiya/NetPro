// apps/web/lib/format.ts
//
// Phase 24 — display-only helpers shared by the server-backed pages. The
// legacy CRM date helpers moved out with the legacy pages; `scoreLabel` is the
// one formatting rule the Pathfinder (and other visualizations) still needs,
// mirroring the CLI's rendering of the 0–1 relationship score.

/** Relationship score on the stored 0–1 scale, rendered like the search table. */
export function scoreLabel(score: number | null | undefined): string {
  return score === null || score === undefined ? "–" : score.toFixed(2);
}
