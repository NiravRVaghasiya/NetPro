# Changelog

All notable changes to NetPro are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
the product milestones in the [project blueprint](NetPro%20%E2%80%94%20Blueprint.md)
(`vX.Y` milestones, published as `X.Y.0` npm/GitHub versions).

## [1.5.0] - 2026-09-07

### Added — Phase 7: CRM tracking & follow-up reminders

- Per-contact interaction history (`meeting`, `call`, `note`, `email_sent`,
  `email_received`, `linkedin_message`, `intro_made`) with whitelisted
  direction/channel vocabularies and length caps, backdating allowed.
- Relationship scoring (recency 40% / frequency 25% / depth 20% / richness
  15%, stored 0–1) recomputed on every logged interaction.
- Follow-up reminders: due-today / overdue / upcoming / completed views,
  complete, snooze (relative or absolute), cancel, and optional recurrence
  (`7d`, `30d`, …).
- Activity-log writes for every CRM mutation (the audit trail the schema
  always promised).
- CLI: `netpro track log|add|list|done|snooze|cancel`, with shared
  `resolveContactRef` selectors and `--json` output.
- Web: `/contacts` CRM table, `/contacts/[id]` timeline + log/schedule panel,
  `/api/contacts`, `/api/interactions`, `/api/follow-ups` (+ `[id]`), and a
  dashboard follow-up-due strip.
- Additive migration `0002` (nine portable indexes, both dialects).

### Added — Phase 8: draft-only batch campaigns

- `packages/core/campaigns`: template rendering with nine whitelisted merge
  variables and save-time validation, recipient snapshots (ids or saved
  search), lifecycle transitions with self-healing stats, daily-limit meter,
  drip scheduling, and sent/replied/skipped mutations.
- Every confirmed send logs a real `email_sent` interaction (feeding CRM
  scoring); a recorded reply logs `email_received` and cancels the drip.
- CLI: `netpro campaign list|create|add-recipients|show|activate|pause|
complete|archive|mark-sent|mark-replied|mark-skipped`.
- Web: `/outreach/campaigns`, `/outreach/campaigns/[id]`, `/api/campaigns`
  (+ `[id]`, `[id]/recipients/[recipientId]`).
- Still draft-only by design: no SMTP client, no stored mail credentials, no
  automatic sending, no open/click/bounce tracking.

### Changed

- `netpro campaign` replaced the `/outreach/campaigns` stub.
- Package versions moved from `0.1.0-alpha.0` to `1.5.0` across all workspace
  packages to mark the milestone release.
- `docs/getting-started.md` now documents `netpro track` and
  `netpro campaign` and no longer lists batch campaigns as "planned".

## [1.0.0] - 2026-09-06

### Added — Phases 1–6 (deployable v1.0)

- Phase 1: LinkedIn CSV import with dedup/merge, three-provider enrichment
  (Hunter.io, People Data Labs, Clearbit), CSV export.
- Phase 2: faceted people search (`netpro search`, `/search`,
  `GET /api/search`).
- Phase 3: network analytics — composite health score, activity/dormancy
  breakdown, growth series, diversity (Shannon entropy), company clusters,
  dormant-ties list (`netpro analyze`, `/dashboard`, `GET /api/analytics`).
- Phase 4: BYO-key AI outreach drafting (OpenAI-compatible + Anthropic over
  plain `fetch`), `netpro outreach`, `/outreach`, `POST /api/outreach`.
- Phase 5: owner-only profile card with published snapshot, `/card`,
  `/card/vcard`, and offline HTML/vCard generation (`netpro card`).
- Phase 6: one-click Vercel deploy, `netpro migrate`, production security
  headers, readiness-aware `/api/health`, hardened Docker Compose stack; fixed
  the concurrent-migration race (advisory lock) and the production
  `UntrustedHost` auth bug; `middleware.ts` → `proxy.ts` for Next.js 16.
- Dual-dialect Drizzle schema (SQLite/Postgres), owner-only GitHub OAuth via
  Auth.js, full monorepo CI (lint, typecheck, 592 tests, build, live
  PostgreSQL integration, Docker image builds).

## [0.1.0-alpha] - 2026-08-31

### Added

- Monorepo scaffold: Turborepo + npm workspaces, `apps/web` (Next.js +
  Auth.js), `apps/cli` (commander), `packages/core|db|ui|config`.
- Blueprint-aligned Drizzle schema (SQLite + Postgres dialects), migration
  runner, seeded fixtures, ESLint/Tailwind shared configs, CI skeleton.

[0.1.0-alpha]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v0.1.0-alpha
[1.0.0]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v1.0.0
[1.5.0]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v1.5.0
