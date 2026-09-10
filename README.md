# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro&env=DB_DIALECT,DATABASE_URL,NEXTAUTH_SECRET,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,NETPRO_OWNER_GITHUB_ID&envDescription=NetPro%20needs%20a%20Postgres%20URL%2C%20an%20auth%20secret%2C%20a%20GitHub%20OAuth%20app%2C%20and%20your%20numeric%20GitHub%20user%20ID&envLink=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro%2Fblob%2Fmaster%2Fdocs%2Fdeployment.md&project-name=netpro&repository-name=netpro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release: v3.0.0](https://img.shields.io/badge/Release-v3.0.0-2ea44f)](https://github.com/NiravRVaghasiya/NetPro/releases)
[![Changelog](https://img.shields.io/badge/Changelog-CHANGELOG.md-8A2BE2)](CHANGELOG.md)

**v1.0 (Phases 1–6), v1.5 (Phases 7–8), v2.0 "The Strategist", v2.5
"The Observer", and v3.0 "The Platform" are implemented** on top of the v0.1-alpha scaffold:

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
  No remote avatars or new runtime dependencies; visitor tracking arrived
  later as v2.5's privacy-preserving beacon (see below).

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
Auth.js) builds, lints, typechecks, and tests successfully — **1698 tests**,
plus 57 more in live PostgreSQL suites that run in CI against a real database
(including a performance pass at 5k contacts / 20k edges / 10k views / 1k
content items, and the view-beacon ingest suite). **v1.0 is deployable and v1.5 is complete:** CRM tracking, follow-up
reminders, and batch campaigns are implemented, and per-contact relationship
scoring now has a producer (interaction logging). **v2.0 — "The Strategist" is
complete** — shipped as `v2.0.0` on 2026-09-08 — **v2.5 — "The Observer" is
complete**, shipped as `v2.5.0` on 2026-09-09 — **and v3.0 — "The Platform" is
complete**, shipped as `v3.0.0` on 2026-09-10:

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
  median on the measured machine).
  CI also pins the promise that **no `pgvector` extension is required** —
  embeddings are portable JSON, so a managed Postgres works as-is.

- **v2.5 — “The Observer”: complete, shipped as `v2.5.0` on 2026-09-09.**
  Migration `0006` and the `@netpro/core/views` module made the
  producer-less `profile_views` table trustworthy and privacy-preserving —
  daily-salted HMAC viewer hashing (no
  raw IPs ever stored; legacy values blanked on upgrade), a vendored bot
  deny-list, owner-view labeling, dedup/filter indexes, and the 90-day
  raw-view retention purge. Phase 2 wired the producer: the public tracking
  beacon (`GET /api/card/pixel.gif`, `POST /api/card/view`) ingests views
  into `profile_views` with rate limiting, allowlisted pages,
  sanitized referrers/UTM, DNT/GPC minimal mode, 5-min/1-h de-duplication,
  and signed `?v=` contact-resolution tokens — plus a settings panel with a
  copy-paste embed snippet and an opt-in pixel for HTML cards
  (`netpro card --pixel-url`). Phase 3 added the query side: windowed view
  stats, the recent timeline, and known-visitor matches in
  `packages/core/views/analytics` (bots/owner excluded with reported
  counts, 90-day window cap, ~23 ms at 10k views), surfaced as
  `netpro card --views` and `netpro analyze --views`, the owner-only
  `GET /api/card/views` and the `views` block of `GET /api/analytics`
  (`?views=0` opts out), a “Profile views” strip on `/dashboard`, and an
  analytics section on `/settings/card`. Phase 4 added the content
  tracker's data model: migration `0007` (`content_items` with a UNIQUE
  normalized-URL dedupe key, append-only `content_metrics` snapshots,
  `content_mentions`), the `@netpro/core/content` module (URL
  canonicalization, alias-tolerant CSV + dependency-free RSS/Atom import,
  metrics snapshots, mentions, windowed overviews), and the provider seam
  (`manual` + `rss` built in; `devto`/`twitter`/`github` as disabled,
  self-explaining stubs). Phase 5 shipped the content surface on top of
  that model: `netpro content` (18th top-level command; `list`/`add`/
  `show`/`import`/`fetch`/`rm`/`analyze`, all with `--json`), the
  owner-only `/api/content` API (list with engagement attached,
  idempotent adds, CSV/feed imports with dry runs and multipart uploads,
  id-or-URL selectors, series + snapshot routes, mention links), the
  `/content` library and `/content/[id]` detail pages (latest snapshot +
  history + contacts), a Content section on `/contacts/[id]`, and a
  "Content" strip on `/dashboard`. Phase 6 tied it all together: the
  content overview joins `getNetworkOverview` (the dashboard's "Content"
  strip and `GET /api/analytics` read one shared payload; `?content=0`
  opts out), the dashboard's strips gained two-step onboarding empty
  states, and a **daily retention job** (web process, in-memory, audited
  in `activity_log`) purges raw profile views past 90 days and content
  snapshots past 365 days — the latest snapshot per piece always
  survives — with `NETPRO_DISABLE_RETENTION` / `NETPRO_VIEW_RETENTION_DAYS`
  / `NETPRO_CONTENT_METRIC_RETENTION_DAYS` operator knobs; the plan's
  performance budgets were measured at 10k views / 1k content / 5k
  metrics (~53 ms dashboard / ~10 ms views / ~2 ms content on SQLite) and
  ship as hermetic budget tests.
- **Phase 7 — Release readiness & the `v2.5.0` cut (shipped):** workspace
  versions moved to `2.5.0`; the CHANGELOG closed out with explicit privacy
  notes and a **Deferred** list (what The Observer deliberately is not:
  cross-day tracking, stranger deanonymization, platform metric
  integrations, third-party scripts); and the **release performance pass
  against a real PostgreSQL server** was extended with the Observer fixture —
  5k contacts / 20k edges plus 10k views / 1k content items / 5k metric
  snapshots — recording **~485 ms** for the full dashboard payload,
  **~16 ms** for the views overview and **~5 ms** for the content list
  (medians, PostgreSQL 18.4).
  CI's Docker smoke now also proves the new boundary in a production build:
  the analytics/content routes answer 401, the beacons stay public,
  cookieless, and `no-store`/`nosniff`.

- **v3.0 — “The Platform”: complete, shipped as `v3.0.0` on 2026-09-10.**
  NetPro stops being a single-owner tool and becomes a workspace-scoped
  platform. Migrations `0008`–`0014` (both dialects), four new core modules
  (`workspaces`, the `crypto` key vault, `plugins`, `webhooks`), three new CLI
  commands, six new web pages and 22 new API routes — and a single-owner
  install keeps behaving exactly as it did in v2.5.
- **Phase 1 — Workspaces & membership (shipped):** migration `0008` adds
  `workspaces`, `workspace_members` and `workspace_invites`, plus a
  `workspace_id` column (and index) on every data table, seeded with a
  `default` bootstrap workspace. The role matrix is owner > admin > member >
  viewer, with a break-glass owner that cannot be removed or demoted and a
  last-owner guard. Surfaced as `netpro team`
  (`list`/`members`/`invite`/`accept`/`remove`/`role`/`revoke`) and the
  admin-only `/settings/team`.
- **Phase 2 — Workspace-scoped engine (shipped):** every core query now
  carries an explicit `workspace_id` predicate through
  `bootstrapScope`/`resolveScope`/`workspacePredicate` — CRM, analytics,
  hybrid search, views/beacon, content, graph edges, events, campaigns,
  skills, enrichment, import/export and the retention purge. Authorship
  (`created_by_user`, migration `0010`) stamps who logged an interaction or
  raised a follow-up, and `0011` backfills any NULL scope into the bootstrap
  workspace and attaches a DB-level `DEFAULT` on Postgres. Every web API
  route and page derives its scope from the session (`requireScope()`), every
  CLI command accepts `--workspace`, and a cross-tenant scope-guard suite
  asserts no workspace can read another's rows.
- **Phase 3 — Team collaboration (shipped):** follow-ups became assignable
  (migration `0012`) with assign/unassign audit trails, removal of a member
  unassigning their pending follow-ups, an owner-transfer flow, and an
  audit viewer — `listActivityLog` behind `/settings/activity` and
  `GET /api/activity`, filterable by action, entity, member and date. The
  dashboard and contacts list gained “Assigned to me” / “Unassigned” views.
- **Phase 4 — Encrypted web key vault (shipped):** migration `0009` plus
  `/settings/keys` store personal and workspace provider credentials
  encrypted at rest with AES-256-GCM and principal/slot-bound key
  derivation. The management API answers masked-only, bodies are bounded,
  writes have member/admin floors, and a read-only env fallback works with no
  master key. Outreach, AI skills, enrichment and semantic search now read
  the vault first; the CLI keychain is unchanged.
- **Phase 5 — Plugin runtime & manifest (shipped):** migration `0013` plus
  `packages/core/src/plugins` — strict manifest validation (npm-style names,
  semver, engine ranges, capability allowlist, exact-host network allowlist),
  an ESM loader that refuses incompatible engines, a per-workspace registry of
  enrichers / AI providers / content providers / event discovery / commands,
  and a `fetch` wrapper that blocks any host the manifest did not declare
  (each block audited). A crashing plugin is isolated, logged and disabled —
  it never takes the app down. Plugins install **disabled** and need an
  explicit `--i-have-reviewed-permissions` (or a reviewed checkbox in
  `/settings/plugins`) before they run. `netpro plugin`
  (`list`/`paths`/`discover`/`info`/`install`/`enable`/`disable`/`rm`/
  `settings`) and a reference plugin ship in-tree.
- **Phase 6 — Self-hosted marketplace (shipped):** `marketplace/index.json`
  (schema 1) plus a GNU-tar tarball in this repo, consumed by
  `netpro plugin search|install|update` and `/settings/plugins`. Installs
  fetch a static index (no telemetry, 1 h cache), verify sha256 (mismatch =
  hard audited refusal), extract with a vendored USTAR reader that rejects
  symlinks, absolute paths, `..` escapes, truncation and oversized archives,
  check that the archive manifest matches the index listing exactly, and
  register the plugin disabled behind the Phase 5 review gate. Updates are
  install-over with version monotonicity. Point `MARKETPLACE_INDEX_URL` at
  your own mirror to self-host; the index is checksums, not curation —
  nothing auto-installs.
- **Phase 7 — Outbound webhooks (shipped):** migration `0014` plus
  `packages/core/src/webhooks` — an 18-event catalog, HMAC-SHA256 signatures
  (`t=<unix>,v1=<hmac>`, 5-minute tolerance), URL validation (http/https
  only, no embedded credentials, 2048-char cap) with a CLI-side
  private-network **warning**, 10 s delivery timeout, exponential backoff
  (60 s base, 32 min cap, 8 attempts), a delivery log with redelivery, and a
  30-day purge folded into the daily retention job. Surfaced as
  `netpro webhook` (`list`/`events`/`add`/`enable`/`disable`/`rotate`/
  `deliveries`/`test`/`redeliver`/`retry`/`rm`), the admin-only
  `/settings/webhooks`, and
  [docs/webhooks.md](docs/webhooks.md) with receiver recipes for Zapier, n8n,
  Make and a plain Node endpoint. Outbound only — no inbound ingestion.
- **Phase 8 — Release readiness & the `v3.0.0` cut (shipped):** every
  workspace moved to `3.0.0` (root, `apps/cli`, `apps/web`, `packages/*`,
  `netpro --version`); CI runs lint, typecheck, test and build on Node 20 and
  22, the live-PostgreSQL integration + performance jobs, a Docker image
  build with a production smoke test, and a marketplace end-to-end pass
  (search → install → update → enable → list against the shipped index).
  Locally that gate is **1698 tests passing** (57 live-Postgres tests run in
  CI) with zero lint or typecheck errors.

**Deferred from v2.0 (deliberate, not forgotten):** live event discovery
providers (the `EventDiscoveryProvider` interface ships, disabled); a native
pgvector column + ANN index (a later optimization); AI skills extraction as a
default (opt-in per run); real SMTP delivery for campaigns (NetPro drafts
today, a human sends); and the `$EDITOR` draft-review loop. (Per-user
encrypted web key storage shipped in v3.0 Phase 4.)

**Deferred from v2.5 (privacy by omission, on purpose):** no cross-day viewer
tracking (daily-salted hashes, 90-day raw-row purge), no contact resolution
from IP/email/user-agent (only the owner's signed `?v=` links), no platform
metric integrations beyond the disabled provider stubs (`manual` + `rss`
ship; devto/twitter/github name the key that would enable them), and no
cookies, third-party scripts, or off-site beacons anywhere in the observer
features — see the CHANGELOG's v2.5 Deferred section.

**Deferred from v3.0 (deliberate, not forgotten):** no plugin sandbox — a
plugin runs in-process with the server's Node privileges, which is exactly why
the manifest's network allowlist, the workspace data boundary and the human
permissions-review gate stand in front of every enable; no curated plugin
store — the marketplace is a static, checksummed index and nothing
auto-installs or auto-updates; no background webhook delivery worker —
deliveries are attempted when the event is emitted and pending ones are
retried on demand (`netpro webhook retry`); private-network webhook targets
are **warned** about in the CLI, not blocked (the pattern check is
hostname-only and never resolves DNS), so egress policy stays with the
operator; no inbound webhook ingestion; and
still no SMTP — campaigns draft, a human sends. See the CHANGELOG's v3.0
Deferred section.

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

The [CHANGELOG](CHANGELOG.md) records what each phase shipped and the
reasoning behind its design decisions.

## Local-first quickstart

Run the whole application on your machine — no Vercel, no cloud, no GitHub
OAuth, no `DATABASE_URL`:

```bash
npm install && npm run build -w apps/cli
node apps/cli/dist/index.js init     # creates ~/.netpro (config, SQLite db, logs, keys)
node apps/cli/dist/index.js serve    # http://127.0.0.1:3777
node apps/cli/dist/index.js status   # install, database, and server health
```

SQLite at `~/.netpro/netpro.db` is the default; PostgreSQL stays available
for Docker/team deployments via `~/.netpro/config.toml` or environment. See
[`docs/local-first.md`](docs/local-first.md).

## Structure

- `apps/web` — Next.js app (App Router), Auth.js v5 with GitHub OAuth
- `apps/cli` — commander CLI (`netpro init|serve|status|config|import|enrich|search|reindex|outreach|analyze|path|track|edge|campaign|export|card|migrate|skills|events|content`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business logic: import, enrichment, export, faceted search, the network analytics engine, the AI outreach drafting engine, profile-card validation/publishing/exports, the CRM (interaction tracking, relationship scoring, follow-up reminders), the draft-only batch campaign engine, graph edge provenance, the v2.0 graph analytics engine (Louvain communities, centrality, warm-intro paths), the Phase 3 pathfinder surface (ranking, first-ask, per-contact graph position), the v2.0 skills taxonomy/gap analyzer, the Phase 6 event matcher (CSV import, attendee matching, recommendations), the v2.5 profile-view beacon + viewer analytics (privacy-hardened ingestion, windowed stats, timelines, known-visitor matches), the v2.5 content tracker data model (URL identity, CSV/feed import, metrics snapshots, mentions, provider interface), the v2.5 daily retention purge (90-day views / 365-day snapshots with latest-per-piece survival, at-most-once-per-24 h, audit-logged), and v3.0 Phase 2's workspace-scoped CRM engine (explicit `workspace_id` predicates threading an optional `WorkspaceScope`, authorship on interactions/follow-ups, and a cross-tenant scope-guard suite)
- `packages/config` — shared ESLint and Tailwind configs

## Deploy

```bash
docker compose up -d          # self-host with Postgres
```

Or use the Vercel button above. Either way, read
[`docs/deployment.md`](docs/deployment.md) first — it covers the managed-Postgres
setup, migrations, owner sign-in, TLS modes, and a production checklist.

See [`docs/getting-started.md`](docs/getting-started.md) to run it locally,
and the [CHANGELOG](CHANGELOG.md) for what each release shipped and why.

## License

MIT
