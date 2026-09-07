// packages/core/src/events/index.ts
//
// v2.0 Phase 6 — the event matcher: "who in my network is going / went to X,
// and who could I go with or be introduced to".
//
// The schema (`events`, `event_attendees`) and the manual "also met at…"
// producer shipped in Phase 1 (migration `0003`, `graph/events.ts`), so this
// phase is logic only. Import path, matching, overlap, recommendations; the
// CLI (`netpro events`), the web (`/events`) and the API all read the same
// functions, so all three surfaces agree.
export * from './types';
export * from './parse';
export * from './match';
export * from './providers';
export * from './repository';
