# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro&env=DB_DIALECT,DATABASE_URL,NEXTAUTH_SECRET,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,NETPRO_OWNER_GITHUB_ID&envDescription=NetPro%20needs%20a%20Postgres%20URL%2C%20an%20auth%20secret%2C%20a%20GitHub%20OAuth%20app%2C%20and%20your%20numeric%20GitHub%20user%20ID&envLink=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro%2Fblob%2Fmaster%2Fdocs%2Fdeployment.md&project-name=netpro&repository-name=netpro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release: v1.5.0](https://img.shields.io/badge/Release-v1.5.0-2ea44f)](https://github.com/NiravRVaghasiya/NetPro/releases)
[![Changelog](https://img.shields.io/badge/Changelog-CHANGELOG.md-8A2BE2)](CHANGELOG.md)

**v1.0 (Phases 1–6), v1.5 (Phases 7–8), and v2.0 Phases 1–3 are
implemented** on top of the v0.1-alpha scaffold:

- **Phase 1 — Import, Enrichment & Export:** LinkedIn CSV import with
  dedup/merge, three-provider contact enrichment (Hunter.io, People Data Labs,
  Clearbit), and CSV export.
- **Phase 2 — People Search:** faceted search over your contacts —
  free-text query plus company/role/location/industry/seniority/email/score/
  activity filters, relevance/score/recent/name sorting, facets, and
  pagination — wired into both the CLI (`netpro search`) and the web app
  (`/search`, `GET /api/search`). Portable SQL by default; v2.0 Phase 4 adds
  the FTS5/`tsvector` and semantic arms behind the same entry point.
- **Phase 3 — Network Analytics:** a composite network health score,
  activity/dormancy breakdown, 12-month growth series, industry/company
  diversity (Shannon entropy), company clusters, and the dormant-ties
  reconnect list — computed in `packages/core/analytics` and surfaced through
  `netpro analyze` and the web dashboard (`/dashboard`, `GET /api/analytics`).
  Imports now persist LinkedIn's "Connected On" date, so growth reflects when
  relationships actually formed.
- **Phase 4 — AI Outreach (Drafting):** BYO-key AI message drafting for a
  contact (by email/id/name) or an ad-hoc recipient — choose a tone
  (professional/warm/casual/friendly), add context and your ask, and get a
  ready-to-send subject + body. The engine lives in `packages/core/ai`
  (OpenAI-compatible and Anthropic providers over plain `fetch`, no SDK
  dependencies, no network in tests), surfaced through `netpro outreach` and
  the web composer (`/outreach`, `POST /api/outreach`). NetPro **drafts** —
  you review and send; nothing is emailed automatically, and the web app
  reads keys only from server env vars (`/settings` shows integration status).
- **Phase 5 — Profile Card:** an owner-only editor (`/settings/card`) with a
  live preview, private drafts, explicit publication, and unpublishing. The
  public `/card` page and `/card/vcard` download read only a separately
  published snapshot — never imported contacts or unsaved/private edits.
  `netpro card --generate --input profile.json` produces a standalone HTML
  card offline; `--format vcard` exports a contact file. Shared validation,
  rendering, and SQLite/Postgres persistence live in `packages/core/card`.
  No visitor tracking, remote avatars, or new runtime dependencies.

- **Phase 6 — Deployment & Release Readiness:** NetPro is now actually
  deployable. One-click **Vercel** deploy with managed Postgres, an explicit
  `netpro migrate` deploy step, production security headers, a readiness-aware
  `/api/health`, and a hardened Docker Compose stack. See
  **[docs/deployment.md](docs/deployment.md)**.

  Verifying against a _real_ PostgreSQL server for the first time surfaced two
  release-blocking bugs that a passing local build could never have shown:

  1. **Concurrent migrations failed 5 of 6 cold starts.** Each instance ran
     migrations at startup, so a Vercel deploy — which cold-starts many
     instances at once — raced against itself (`CREATE TABLE "account"`, and
     even `CREATE SCHEMA IF NOT EXISTS`, which races with itself in Postgres).
     Now serialized with a Postgres advisory lock, with a mutation-verified
     regression test.
  2. **Production authentication was completely broken.** Auth.js v5 derives
     host trust from `AUTH_URL`/`AUTH_TRUST_HOST`/`VERCEL` — _not_ from
     `NEXTAUTH_URL`, which is what NetPro's docs told operators to set. Every
     self-hosted production request failed with `UntrustedHost`. Development
     and Vercel both masked it.

  Also: `middleware.ts` → `proxy.ts` for Next.js 16, and the build now emits
  **zero warnings** (was six).

- **Phase 7 — CRM Tracking & Follow-up Reminders:** per-contact interaction
  history (email, meeting, call, note, LinkedIn message, intro) with a
  documented **relationship score** — recency 40% / frequency 25% / depth 20% /
  richness 15%, recomputed on every logged interaction — plus follow-up
  reminders with due-today/overdue/upcoming views, completion, snooze, cancel,
  and optional recurrence, and a unified per-contact timeline. The engine lives
  in `packages/core/crm`, surfaced through `netpro track` and the web app
  (`/contacts`, `/contacts/[id]`, `GET/POST /api/interactions`,
  `/api/follow-ups`).

- **Phase 8 — Batch Campaigns (Draft-Only):** personalized multi-step outreach
  with whitelisted merge variables (`{{firstName}}`, `{{company}}`, `{{role}}`,
  …), drip sequences with per-step delays, recipients snapshotted from an
  explicit list or a saved search, a lifecycle (draft → active →
  paused/completed/archived), and a per-day send limit. NetPro **drafts** each
  personalized message; a human sends it from their own mailbox and records the
  outcome — every confirmed send is logged as a real interaction (feeding the
  relationship score), and a recorded reply cancels the remaining drip. The
  engine lives in `packages/core/campaigns`, surfaced through `netpro campaign`
  and the web app (`/outreach/campaigns`, `/outreach/campaigns/[id]`,
  `/api/campaigns`). No SMTP, no stored secrets, nothing sent automatically.

> **Upgrade / owner setup:** set `NETPRO_OWNER_GITHUB_ID` to your numeric GitHub
> account ID before signing in. Only that account can access the private
> workspace; missing configuration denies sign-in. Existing sessions must sign
> in again. The previously missing Auth.js callback route is now mounted.
> See [owner authentication setup](docs/getting-started.md#configure-owner-sign-in).

The full monorepo (CLI + web, dual-dialect Drizzle database, GitHub OAuth via
Auth.js) builds, lints, typechecks, and tests successfully — **1191 tests**,
plus 38 more in live PostgreSQL suites that run in CI against a real database
(including a performance pass at 5k contacts / 20k edges). **v1.0 is deployable and v1.5 is complete:** CRM tracking, follow-up
reminders, and batch campaigns are implemented, and per-contact relationship
scoring now has a producer (interaction logging). **v2.0 — "The Strategist" is
complete** — shipped as `v2.0.0` on 2026-09-08 (see the [v2.0 implementation
plan](docs/superpowers/plans/2026-09-07-v2.0-implementation-plan.md)):

- **Phase 1 — Edge provenance (shipped):** `edges` gained `source`,
  `confidence`, `status` + indexes, plus `netpro edge`, CSV mutuals as
  *pending* candidates, and “also met at…” attendance.
- **Phase 2 — Graph analytics engine (shipped):** pure-TS Louvain community
  detection, degree + Brandes betweenness centrality, and a warm-intro
  pathfinder (BFS over `edges`, `maxDepth` 4 default) in
  `packages/core/graph`, surfaced through `netpro analyze --graph`, the
  `graph` payload of `GET /api/analytics`, and a “Network graph” strip on
  `/dashboard`. Over-budget graphs degrade with documented notices, never
  silent zeroes.
- **Phase 3 — Pathfinder surface (shipped):** `netpro path <target>` resolves
  selectors (or defaults to your strongest tie), ranks the k-shortest chains
  by relationship strength (0.6 × weakest-tie + 0.4 × mean hop strength), and
  names the first ask — with `--draft` handing that ask to the Phase 4 AI
  composer (draft-only, as ever). The web app got `/graph` (target picker +
  ranked chain cards + one-click "Draft intro request" that pre-fills the
  outreach composer), `/graph/<contactId>` (centrality, community, adjacency
  incl. pending rows), and the owner-only APIs `GET /api/graph/paths` +
  `GET /api/graph/overview`. Chains are ranked; **you** pick the intermediary
  — the plan's auto-pick stays deferred.
- **Phase 4 — Hybrid search (shipped):** additive migration `0004` gives
  `search_index` a real producer plus an FTS5 virtual table (SQLite) and a
  generated `tsvector` + GIN index (Postgres). `searchContacts` is now a
  three-arm dispatcher — portable substring, keyword full-text, and an
  opt-in embedding arm — merged with **reciprocal rank fusion** (k=60).
  The keyword arm indexes the whole contact document (notes, tags, industry,
  seniority, department, country), so it finds people substring matching
  misses. Surfaced as `netpro search --mode keyword|hybrid` / `--semantic`,
  the new `netpro reindex [--embeddings] [--status]`, a `/search` engine
  selector + "Results powered by…" badge, `GET /api/search?mode=`, and a
  `search` block in the owner-only health payload. **Configuring nothing
  changes nothing**: no index → substring search, no key → no semantic arm,
  provider down → keyword results with a stated reason rather than an error.
- **Phase 5 — Skills gap analyzer (shipped):** additive migration `0005`
  adds `contacts.skills`; `packages/core/skills` derives skills from
  headline, role, tags, custom fields and notes against an embedded,
  explainable taxonomy (~100 skills, alias table, whole-token matching, every
  hit carries its field + snippet as evidence) and compares a target role /
  job description / skill list against one contact or the whole network —
  present, partial (via named adjacent-skill rules), missing, a match score,
  per-skill coverage and the skills nobody has. Verdicts live on the contact,
  evidence in `enrichments`; re-runs are idempotent and only write changes.
  Surfaced as `netpro skills [contact] | gap | extract | status`,
  `netpro search --skills`, the `/skills` page + skill tags on contact
  pages, and the owner-only `GET /api/skills/gap` / `POST /api/skills/extract`.
  **Offline by default**: the AI pass is opt-in per run, may only pick from
  the taxonomy, and degrades to the heuristic result when the model fails.
- **Phase 6 — Event matcher (shipped):** no migration — Phase 1's `events`
  and `event_attendees` tables finally have a producer. `packages/core/events`
  imports a conference CSV (alias-tolerant headers: `Event Name`, `starts_at`,
  `Attendee Emails`…), matches each attendee line against your contacts in
  three explainable tiers — exact email (1.0), exact name (0.9), last name +
  first initial (0.6, reported but never linked without asking) — and refuses
  to choose when more than one person fits. Imports are idempotent, and the
  `met_at_event` edges they create land **pending**: an attendee list is
  evidence of attendance, not of a meeting. Attendee lines that resolve to
  nobody are parked on the event (in `activity_log`) so you can re-check them
  after importing new contacts, or link them by hand. `recommendEvents` ranks
  where to go next — 0.6 × how many of your contacts went, 0.2 × industry fit,
  0.2 × timing — and prints the reason for every score. Surfaced as
  `netpro events list|show|add|import|match|link|unlink|recommend|rm`, the
  `/events` and `/events/[id]` pages, an **Events** section on each contact,
  and the owner-only `GET/POST /api/events`, `GET/DELETE /api/events/[id]`,
  `POST /api/events/[id]/match` and `POST/DELETE /api/events/[id]/attendees`.
  Pairwise linking is capped per event (250) and says so when it stops, and
  live event *discovery* ships as a disabled provider interface — no scraping,
  no network.
- **Phase 7 — Release readiness & the `v2.0.0` cut (shipped):** workspace
  versions moved to `2.0.0`; the CHANGELOG closed out with an explicit
  **Deferred** list; deployment docs gained the skills, events and graph
  operating notes; and the release gate now includes a **performance pass
  against a real PostgreSQL server** — 5k contacts / 20k edges, timing the
  dashboard, hybrid search and the graph endpoints (327 ms / 32 ms / 209 ms
  median on the measured machine, recorded in the [Phase 7 progress
  doc](docs/superpowers/plans/2026-09-08-v2.0-phase7-release-progress.md)).
  CI also pins the promise that **no `pgvector` extension is required** —
  embeddings are portable JSON, so a managed Postgres works as-is.

**Deferred from v2.0 (deliberate, not forgotten):** live event discovery
providers (the `EventDiscoveryProvider` interface ships, disabled); a native
pgvector column + ANN index (a later optimization); AI skills extraction as a
default (opt-in per run); real SMTP delivery for campaigns (NetPro drafts
today, a human sends); per-user encrypted web key storage and the `$EDITOR`
draft-review loop — the last two documented in the
[Phase 4 design spec](docs/superpowers/specs/2026-09-06-v1.0-phase4-ai-outreach-design.md).

> **Analytics scope note:** the clustering story is **two-section** and, since
> v2.0 Phase 3, graph-native end to end: attribute clusters (normalized
> company) remain for “who's where”, while the **Network graph** section —
> Louvain communities, centrality, components, average path length, warm-intro
> candidates, and now the ranked pathfinder itself (`/graph`, `netpro path`,
> `GET /api/graph/*`) — runs over the confirmed `edges`. Inferred (pending)
> edges are excluded until the owner confirms them (every surface offers a
> `--status all` / "confirmed + pending" preview). Phase 1's producers
> (`netpro edge`, CSV mutuals as *pending* candidates, “also met at…”
> attendance) feed the graph; per-contact **relationship scoring ships with
> the CRM (Phase 7)**, is recomputed on every logged interaction, and since
> Phase 3 is what ranks intro chains — recency + score appear on every hop.

> **Search implementation note:** `searchContacts` is a three-arm dispatcher
> (portable substring, keyword full-text, opt-in semantic) merged with
> reciprocal rank fusion — see Phase 4 above. The portable arm alone runs
> identically on both dialects, so an un-migrated or un-indexed database keeps
> working; the keyword and semantic arms light up when the migration and a key
> are present. A native pgvector column for the semantic arm remains a
> documented later optimization.

See the [Phase 1 plan](docs/superpowers/plans/2026-08-31-v1.0-phase1-import-enrichment-export.md)
and its [design spec](docs/superpowers/specs/2026-08-31-v1.0-phase1-import-enrichment-export-design.md)
for what Phase 1 covers and why, the
[Phase 3 design spec](docs/superpowers/specs/2026-09-06-v1.0-phase3-network-analytics-design.md)
for the analytics decisions, and the
[Phase 5 design and repository assessment](docs/superpowers/specs/2026-09-06-v1.0-phase5-profile-card-design.md)
for publication/privacy decisions and the remaining release work, the
[Phase 7 design spec](docs/superpowers/specs/2026-09-06-v1.5-phase7-crm-tracking-followups-design.md)
for the CRM/relationship-scoring decisions, and the
[Phase 8 design spec](docs/superpowers/specs/2026-09-06-v1.5-phase8-batch-campaigns-design.md)
for the draft-only campaign decisions.

## Structure

- `apps/web` — Next.js app (App Router), Auth.js v5 with GitHub OAuth
- `apps/cli` — commander CLI (`netpro init|config|import|enrich|search|reindex|outreach|analyze|path|track|edge|campaign|export|card|migrate|skills|events`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business logic: import, enrichment, export, faceted search, the network analytics engine, the AI outreach drafting engine, profile-card validation/publishing/exports, the CRM (interaction tracking, relationship scoring, follow-up reminders), the draft-only batch campaign engine, graph edge provenance, the v2.0 graph analytics engine (Louvain communities, centrality, warm-intro paths), the Phase 3 pathfinder surface (ranking, first-ask, per-contact graph position), the v2.0 skills taxonomy/gap analyzer, and the Phase 6 event matcher (CSV import, attendee matching, recommendations)
- `packages/ui` — shared React components
- `packages/config` — shared ESLint and Tailwind configs

## Deploy

```bash
docker compose up -d          # self-host with Postgres
```

Or use the Vercel button above. Either way, read
[`docs/deployment.md`](docs/deployment.md) first — it covers the managed-Postgres
setup, migrations, owner sign-in, TLS modes, and a production checklist.

See [`docs/getting-started.md`](docs/getting-started.md) to run it locally,
and [`docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md`](docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md)
for the design this scaffold implements.

## License

MIT
