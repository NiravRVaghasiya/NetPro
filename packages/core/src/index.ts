export * as search from './search';
export * as enrichment from './enrichment';
export * as analytics from './analytics';
export * as ai from './ai';
export * as crm from './crm';
export * as importPipeline from './import';
export * as exportPipeline from './export';
export * as card from './card';
export * as campaigns from './campaigns';
export * as graph from './graph';
export * as skills from './skills';
// v2.0 Phase 6 — event matcher (attendee import, matching, recommendations).
export * as events from './events';
// v2.5 Phase 1 — profile-view privacy foundations: hashing, bot detection,
// owner-view labeling, retention (see docs/superpowers/plans/2026-09-08-v2.5-implementation-plan.md).
export * as views from './views';
// v2.5 Phase 4 — content cross-posting tracker: data model, URL identity,
// CSV/feed import, metrics snapshots, mentions, provider interface.
export * as content from './content';
// v2.5 Phase 6 — the daily retention purge: bounds `profile_views` (90 d)
// and `content_metrics` (365 d, latest per item kept), at most one run per
// 24 h, audited in `activity_log`.
export * as retention from './retention';
// v3.0 Phase 1 — workspaces data model & multi-user auth.
export * as workspaces from './workspaces';

export * as vault from './crypto';

// v3.0 Phase 5 — plugin runtime & manifest.
export * as plugins from './plugins';

// v3.0 Phase 7 — outbound webhooks
export * as webhooks from './webhooks';
