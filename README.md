# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro&env=DB_DIALECT,DATABASE_URL,NEXTAUTH_SECRET,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,NETPRO_OWNER_GITHUB_ID&envDescription=NetPro%20needs%20a%20Postgres%20URL%2C%20an%20auth%20secret%2C%20a%20GitHub%20OAuth%20app%2C%20and%20your%20numeric%20GitHub%20user%20ID&envLink=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro%2Fblob%2Fmaster%2Fdocs%2Fdeployment.md&project-name=netpro&repository-name=netpro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release: v1.5.0](https://img.shields.io/badge/Release-v1.5.0-2ea44f)](https://github.com/NiravRVaghasiya/NetPro/releases)
[![Changelog](https://img.shields.io/badge/Changelog-CHANGELOG.md-8A2BE2)](CHANGELOG.md)

**v1.0 (Phases 1–6), v1.5 (Phases 7–8), and v2.0 Phases 1–2 are
implemented** on top of the v0.1-alpha scaffold:

- **Phase 1 — Import, Enrichment & Export:** LinkedIn CSV import with
  dedup/merge, three-provider contact enrichment (Hunter.io, People Data Labs,
  Clearbit), and CSV export.
- **Phase 2 — People Search:** faceted full-text search over your contacts —
  free-text query plus company/role/location/industry/seniority/email/score/
  activity filters, relevance/score/recent/name sorting, facets, and
  pagination — wired into both the CLI (`netpro search`) and the web app
  (`/search`, `GET /api/search`).
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
Auth.js) builds, lints, typechecks, and tests successfully — **698 tests**,
plus a live PostgreSQL integration suite that runs in CI against a real
database. **v1.0 is deployable and v1.5 is complete:** CRM tracking, follow-up
reminders, and batch campaigns are implemented, and per-contact relationship
scoring now has a producer (interaction logging). **v2.0 — "The Strategist"**
is underway (see the [v2.0 implementation
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
- Still ahead in v2.0: the pathfinder surface (`/graph`, `netpro path`,
  draft-the-intro), hybrid search (FTS5 + pgvector + RRF), the skills gap
  analyzer, the event matcher, and the release cut. The blueprint also lists real SMTP delivery
for campaigns as optional follow-up work (NetPro drafts today; a human sends).
Per-user encrypted web key storage and the `$EDITOR` draft-review loop remain
deferred and are documented in the
[Phase 4 design spec](docs/superpowers/specs/2026-09-06-v1.0-phase4-ai-outreach-design.md).

> **Analytics scope note:** as of v2.0 Phase 2 the clustering story is
> **two-section**: attribute clusters (normalized company) remain for
> “who's where”, while the **Network graph** section is graph-native — Louvain
> communities, centrality, components, average path length, and warm-intro
> candidates over the confirmed `edges`. Inferred (pending) edges are excluded
> until the owner confirms them. Phase 1's producers (`netpro edge`, CSV
> mutuals as *pending* candidates, “also met at…” attendance) feed the graph;
> per-contact **relationship scoring ships with the CRM (Phase 7)** and is
> recomputed on every logged interaction.

> **Search implementation note:** this is the v1 _portable_ search —
> case-insensitive substring matching and facets in ANSI SQL that runs
> identically on SQLite and Postgres. The blueprint's hybrid engine (SQLite
> FTS5 + pgvector embeddings with RRF re-ranking) is deferred to a later
> phase and will build on the same `searchContacts` entry point.

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
- `apps/cli` — commander CLI (`netpro init|config|import|enrich|search|outreach|analyze|track|edge|campaign|export|card|migrate`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business logic: import, enrichment, export, faceted search, the network analytics engine, the AI outreach drafting engine, profile-card validation/publishing/exports, the CRM (interaction tracking, relationship scoring, follow-up reminders), the draft-only batch campaign engine, graph edge provenance, and the v2.0 graph analytics engine (Louvain communities, centrality, warm-intro paths)
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
