// Display-only date/score formatting shared by the CRM pages. Mirrors the
// CLI's relativeDay (UTC-day granularity) so both surfaces speak the same
// language: "today", "tomorrow", "yesterday", "in 3d", "2d ago".
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** `2026-09-13` — the UTC day of an ISO timestamp. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Human offset in whole UTC days between an ISO timestamp and now. */
export function relativeDayLabel(iso: string, now: Date = new Date()): string {
  const diff = Math.round((startOfUtcDay(new Date(iso)) - startOfUtcDay(now)) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff}d` : `${-diff}d ago`;
}

/** `2026-09-13 (in 7d)` — the compact form used in tables. */
export function dueLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '–';
  return `${utcDay(iso)} (${relativeDayLabel(iso, now)})`;
}

/** Relationship score on the stored 0–1 scale, rendered like the search table. */
export function scoreLabel(score: number | null | undefined): string {
  return score === null || score === undefined ? '–' : score.toFixed(2);
}
