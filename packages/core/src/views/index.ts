// v2.5 Phase 1 — profile views: privacy & retention foundations.
// v2.5 Phase 2 — the tracking beacon & ingestion pipeline on top of them.
//
// Scope of this phase (see docs/superpowers/plans/2026-09-08-v2.5-implementation-plan.md):
// make the scaffold's producer-less `profile_views` table trustworthy,
// privacy-preserving and queryable. Migration `0006` (both dialects) adds the
// hardened columns and indexes; these modules are the pure, testable helpers
// the Phase 2 beacon and Phase 3 analytics will consume:
//
//   * `privacy.ts` — daily-salted HMAC hashing: no raw IP ever persisted,
//     no cross-day correlation.
//   * `bots.ts` — vendored bot list + conservative word backstop for
//     `is_bot`.
//   * `owner.ts` — owner-view labeling (session flag or same-IP heuristic);
//     never blocks, never deletes.
//   * `retention.ts` — the 90-day raw-view purge query.
//
// Phase 2 adds the ingestion pipeline itself:
//
//   * `referrer.ts` — referrer → `scheme://host/path`, capped, no tokens.
//   * `utm.ts` — capped `utm_source/medium/campaign` attribution.
//   * `ratelimit.ts` — in-memory 60/min-per-IP fixed-window limiter.
//   * `beacon.ts` — header extraction (IP/geo/DNT), the `viewed_page`
//     allowlist, dedup, `recordView` (the actual producer), and signed
//     `?v=` contact-resolution tokens.
//
// Phase 3 adds the query side on top of the same table:
//
//   * `analytics.ts` — windowed stats, the recent timeline, top referrers
//     and known-visitor matches. Bots and owner views are excluded unless
//     opted in; the excluded counts are always reported alongside.
export * from './analytics';
export * from './beacon';
export * from './bots';
export * from './owner';
export * from './privacy';
export * from './ratelimit';
export * from './referrer';
export * from './retention';
export * from './utm';
