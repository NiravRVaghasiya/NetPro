// packages/core/src/skills
//
// v2.0 Phase 5 — skills gap analyzer.
//
//   taxonomy.ts   the bounded, embedded skill vocabulary (+ aliases, partial-
//                 coverage rules) — no network, no dependency
//   extract.ts    heuristic extraction with evidence; optional AI pass that may
//                 only choose from the taxonomy
//   gap.ts        pure gap analysis: one candidate, or the whole network
//   repository.ts reads/writes: verdict on `contacts.skills`, evidence in
//                 `enrichments`, the batch producer, status counts
//
// Shared by `netpro skills`, `/skills`, the contact page, and the owner-only
// `/api/skills/*` routes.
export * from './taxonomy';
export * from './extract';
export * from './gap';
export * from './repository';
