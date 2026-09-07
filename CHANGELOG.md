# Changelog

All notable changes to NetPro are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
the product milestones in the [project blueprint](NetPro%20%E2%80%94%20Blueprint.md)
(`vX.Y` milestones, published as `X.Y.0` npm/GitHub versions).

## [Unreleased]

### Added — v2.0 Phase 6: Event matcher

- No migration: Phase 1's `events` / `event_attendees` tables finally have a
  producer. New `@netpro/core/events` module — CSV import, attendee matching,
  overlap, and recommendations.
- Import: alias-tolerant headers (`Event Name`, `starts_at`, `Attendee
  Emails`, `names`…), attendees split on `, ; |` and newline, and dates
  normalized to UTC ISO. Unparseable or ambiguous dates (`14/03/2026`,
  `2026-02-31`) are **rejected per row** rather than guessed. Imports are
  idempotent — events dedupe on normalized name, attendance on
  `(event, contact)` — and support `--dry-run` / `{ dryRun: true }`.
- Matching is three explainable tiers: exact email (1.0), exact name (0.9 —
  accent-, case- and punctuation-insensitive), last name + first initial
  (0.6, reported as `review` and never linked unless asked). Anything with
  more than one plausible contact is `ambiguous` and is returned with its
  candidates; a line whose email and name disagree is ambiguous too. No code
  path picks between two people.
- **Imported `met_at_event` edges are `pending`** (`source = event_import`):
  an attendee list is evidence of attendance, not of a meeting. Manual links
  (`netpro events link`, the web form) are `confirmed`. Pairwise linking is
  capped at 250 edges per event per run and reports `edgeCapReached` when it
  stops. Attendance for an event that has not started is recorded as
  `planned` (`attended = false`).
- Attendee lines that match nobody are parked per event in `activity_log`
  (`action = events.unmatched`, replaced each run) — no new table — so they
  can be re-checked after importing new contacts or linked by hand.
- `recommendEvents` ranks events `0.6 × peers` (how many of your contacts
  went; 5 saturates it) `+ 0.2 × industry` (share of your network in the
  attendees' industries) `+ 0.2 × timing`, returns the reason for every
  component, and drops empty past events. Timing is UTC-day granular so a
  page cannot print "in 7d" and "starts in 6 days" for one event.
- CLI (17th command): `netpro events list|show|add|import|match|link|unlink|
  recommend|rm`, each with `--json`; event selectors take an id or an exact
  name and refuse to guess between same-named events.
- Web: `/events` (list, filters, **Where to go next** recommendations with
  reasons, add form, CSV import panel that previews first and names ambiguous
  rows), `/events/[id]` (attendee overlap strongest-tie first, industries and
  companies, the unmatched bucket with per-row linking, a re-match panel, and
  delete), an **Events** section on `/contacts/[id]`, an **Events** nav link,
  `/events` in the proxy's protected routes, and the owner-only APIs
  `GET/POST /api/events`, `GET/DELETE /api/events/[id]`,
  `POST /api/events/[id]/match` and `POST/DELETE /api/events/[id]/attendees`.
  `EventError` now maps to HTTP the way `CrmError` and `GraphError` do
  (400 / 404 / 409; ambiguity is 400 everywhere).
- Live event *discovery* (Luma/Eventbrite) is **not** shipped: it lands as a
  `EventDiscoveryProvider` interface with a disabled default, so a provider
  can be added later without touching the core, the CLI or the web.

### Added — v2.0 Phase 5: Skills gap analyzer

- Additive migration `0005` (both dialects) adds a nullable
  `contacts.skills` text column holding the derived verdict as a JSON array
  of canonical taxonomy names. Imported source fields are never modified.
- New `@netpro/core/skills` module: an embedded taxonomy (~100 skills in 12
  categories with an alias table — `k8s` → `kubernetes`, `data engineer` →
  `data engineering`), whole-token extraction from headline, role,
  department, industry, tags, custom fields and notes with per-skill
  **evidence** (`field`, matched alias, snippet) and confidence, an optional
  AI pass that may only choose from the taxonomy, `parseTarget` /
  `gapAnalysis` (`present`, `partial` + `partialVia`, `missing`,
  `matchScore = (present + ½·partial) / required`), `analyzeNetworkGaps`
  (per-skill coverage, gaps nobody covers, ranked candidates) and
  `networkSkillCounts`. Ambiguous bare words (`go`, `excel`, `spark`, `swift`,
  `growth`, `operations`, `strategy`) only match in prose through an
  unambiguous alias, but count as explicit tags or `--skills` values.
- Persistence: `extractSkillsBatch` stores the verdict on the contact and the
  full extraction in `enrichments` (`provider = skills_heuristic | skills_ai`,
  `data_type = skills`, one row per contact per extractor, replaced on
  re-run), bumps `updated_at` and writes a `skills.extracted` activity-log
  row **only when the verdict changes**, and refreshes the keyword search
  index for changed contacts (best-effort, never an embedding call).
- Search: `contacts.skills` is part of the indexed document, and a new
  `skills` filter (`netpro search --skills python,k8s`, `GET /api/search?skills=`)
  requires every listed skill; a name outside the taxonomy matches nothing
  rather than silently widening the result.
- CLI (16th command): `netpro skills <contact>` (stored + current skills with
  evidence), `netpro skills gap --role --description --skills [--contact]
  [--limit] [--json]`, `netpro skills extract [--mode heuristic|ai] [--contact]
  [--limit] [--dry-run] [--provider]`, `netpro skills status`. `--mode ai`
  reuses the outreach credentials (keychain / env) and fails before touching
  the database when no key is configured.
- Web: `/skills` (target form, coverage table with contact + warm-intro links,
  gaps, ranked matches, a "Derive skills" panel, and a network skill map when
  no target is given), skill tags with evidence on `/contacts/[id]` (stored
  skills the current text no longer supports are marked), a **Skills** nav
  link, `/skills` in the proxy's protected routes, and the owner-only APIs
  `GET /api/skills/gap?role=&description=&skills=&contact=&limit=` (unknown
  contact → 404, ambiguous → 400 via the shared resolver) and
  `GET|POST /api/skills/extract` (`{ mode?, contact?, dryRun?, limit? }`; AI
  keys come from the server environment only).
- Decision (plan open question #3): **AI extraction is default-off.** The
  heuristic pass is the product; the model is a bounded, opt-in bonus.

### Added — v2.0 Phase 4: Hybrid search

- Additive migration `0004` (both dialects) turns `search_index` into a real
  index: `search_text`/`content_hash`/`embedding` columns, an FTS5 virtual
  table with `unicode61 remove_diacritics 2` + sync triggers on SQLite, and a
  generated `search_vector tsvector` with a GIN index on Postgres. v1 portable
  search keeps working untouched on an un-migrated or un-indexed database.
- `searchContacts()` is now a dispatcher over three arms behind the **same
  entry point and the same filters**: portable substring (always), keyword
  full-text (`bm25()` / `ts_rank`, prefix matching), and an opt-in semantic
  arm. Results are merged with **reciprocal rank fusion** (`k=60`, weights
  keyword 1 / semantic 0.9 / portable 0.5) and deduped per contact. Every
  response carries an `engine` report naming which arms ran, how many hits
  each returned, and *why* one was skipped.
- The keyword arm indexes the full contact document — name, email, headline,
  company, role, seniority, department, industry, location, country, tags and
  **notes** — so it finds people the six-column substring search cannot.
- `netpro reindex [--embeddings] [--force] [--status]` builds and inspects the
  index; it is content-hash guarded, so re-running it is nearly free. Imports
  produce index rows automatically (best-effort — a failed index write never
  fails an import) and **never call an embedding provider**.
- CLI `netpro search --mode portable|keyword|hybrid` / `--semantic`, plus an
  `Engine: …` line explaining the result set. Web: an engine selector on
  `/search` (the semantic option is hidden unless the server has a key), a
  "Results powered by …" badge with actionable hints, `GET /api/search?mode=`
  (unknown mode → explicit 400, never a silent downgrade), and an owner-only
  `search` block in `GET /api/health?verbose`.
- New env, all optional and defaulting to off: `EMBEDDINGS_PROVIDER`
  (`openai|disabled`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`,
  `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_DIMENSIONS`. The CLI also reads them from
  the encrypted keychain (`netpro config set embeddings.key`). Keys stay
  server-side; the browser never receives one.
- **No configuration = no behaviour change.** No index → substring search; no
  key → no semantic arm; SQLite → keyword-only (no vector support); embeddings
  API down mid-request → keyword results with a stated reason, not an error.
- No new runtime dependencies (the embeddings client is fetch-only, mirroring
  the existing AI provider surface). Measured on 1,000 contacts: cold reindex
  85 ms, warm 10 ms, portable query 12 ms, keyword 14 ms, hybrid 33 ms.

### Added — v2.0 Phase 3: Warm-intro pathfinder surface

- The Phase 2 engine gains its decision layer in `packages/core/graph`:
  `planIntroPaths()` (selectors → ranked chains), `rankIntroPaths` /
  `scoreIntroPath` (score = 0.6 × weakest-tie + 0.4 × mean hop
  strength×confidence — deterministic, hand-tested), `defaultPathOrigin`
  (strongest tie, skipping the target itself), and `buildIntroAskInput`
  (feeds the Phase 4 compose pipeline — draft-only, BYO-key).
- `IntroPathNode` now carries `lastInteraction`, so every hop shows your
  relationship score **and** recency on both surfaces.
- CLI: `netpro path <target> [--from] [--max-depth n] [--relation r]
  [--status s] [--alt n] [--draft] [--json]` — ranked k-shortest chains, the
  first ask to make, and an optional AI-drafted ask email. A failed `--draft`
  prints the plan and exits non-zero so scripts can tell.
- Web: `/graph` — server-rendered target picker (contact datalist + free
  selectors), ranked chain cards with per-hop provenance, and a one-click
  **Draft intro request** deep link that pre-fills the outreach composer
  (`/outreach?contactId=&context=&purpose=`). `/graph/<contactId>` shows one
  person's centrality, Louvain community, adjacency (pending rows included,
  so the page doubles as a confirmation entry point) and the suggestions
  they appear in.
- API (owner-only via the proxy, like every `/api` route):
  `GET /api/graph/paths?target=&from=&depth=&relation=&status=&k=` (unknown
  target 404, ambiguous selector 400, depth capped to 1–6 for the web while
  the engine/CLI keep the 1–8 range) and `GET /api/graph/overview`.
- No migration (Phase 1's `0003` covers everything read), no new runtime
  dependencies, and "auto-picking the intermediary" stays deferred per the
  plan: chains are **ranked**, the human chooses.

### Added — v2.0 Phase 2: Graph analytics engine

- `packages/core/graph` analytics: pure-TS **Louvain community detection**
  (no new dependency — decision + measurement in the phase progress doc),
  degree + **Brandes betweenness** centrality, and a **warm-intro pathfinder**
  (bounded BFS over `edges`; `maxDepth` default 4; one-way rows traversed
  one way only; `rejected` never; `pending` only via `status=all`).
- `getNetworkGraph()` — merged dashboard view: node/edge coverage,
  communities (modularity + labels), most-connected list, components, exact
  average path length, and warm-intro candidate pairs (contact → hub via the
  strongest intermediary). Over-budget graphs degrade honestly (documented
  caps: 50k edges, 1.5k-node betweenness, 600-node APL — each skip reported,
  never faked).
- `netpro analyze --graph` section (fourth mutually exclusive section flag);
  `--json` carries the graph payload.
- Web: `GET /api/analytics` now includes `graph` (`?graph=0` opts out) and
  `/dashboard` renders a server-rendered **Network graph** strip with
  onboarding empty state, pending-candidate nudge, and cap-notice degrade.
- `analytics/metrics.test.ts` and the CLI/web analytics test fixtures moved
  onto the migrated `createTestSqliteConn` fixture — no duplicated DDL.
- No migration: Phase 1's `0003` (columns + indexes) is all this reads.

### Added — v2.0 Phase 1: Edge provenance

- Additive migration `0003` (both dialects): `edges.source`, `edges.confidence`,
  `edges.status`, neighborhood/filter indexes, plus `events` and
  `event_attendees` (schema for Phase 6).
- `packages/core/graph`: confirmed/pending/rejected CRUD, symmetric-pair
  collapse, LinkedIn mutual-connection candidates (never auto-confirmed),
  two-column CSV import, and “also met at…” attendance that writes
  `met_at_event` edges.
- CLI: `netpro edge add|list|rm|import|merge|confirm|reject`.
- Web: `/edges`, `/api/edges`, contact-detail “Also met at…” panel.

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
