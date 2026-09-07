// packages/core/src/campaigns
//
// Batch campaign engine (draft-only): templates with whitelisted merge
// variables, drip sequences, recipient snapshots from ids or search,
// lifecycle transitions, per-recipient draft rendering with a daily-limit
// meter, and the human-in-the-loop send ledger that records confirmed sends
// as CRM interactions. Shared by the CLI (`netpro campaign`) and the web app
// (`/outreach/campaigns`, `/api/campaigns`).
export * from './types';
export * from './template';
export * from './repository';
export * from './render';
