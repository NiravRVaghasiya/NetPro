// packages/core/src/crm
//
// CRM engine: interaction logging with relationship-score recomputation,
// contact timelines, and follow-up reminders — shared by the CLI
// (`netpro track`) and the web app (`/contacts`, CRM API routes).
// Phase 8's campaigns module logs confirmed sends through `logInteraction`,
// so scoring, stats, and the activity log stay single-sourced.
export * from './types';
export * from './activity';
export * from './scoring';
export * from './interactions';
export * from './follow-ups';
export * from './timeline';
export * from './contacts';
