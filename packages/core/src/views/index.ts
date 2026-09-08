// v2.5 Phase 1 — profile views: privacy & retention foundations.
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
export * from './bots';
export * from './owner';
export * from './privacy';
export * from './retention';
