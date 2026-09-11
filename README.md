# NetPro

**Your professional network, owned by you.** NetPro is a local-first, open-source
alternative to LinkedIn Premium: import your connections, search them properly,
understand the graph, keep the relationships alive — from a CLI, a local HTTP API,
and a web UI that owns none of your data.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/NiravRVaghasiya/NetPro)](https://github.com/NiravRVaghasiya/NetPro/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![CI](https://github.com/NiravRVaghasiya/NetPro/actions/workflows/ci.yml/badge.svg)](https://github.com/NiravRVaghasiya/NetPro/actions/workflows/ci.yml)

---

## Table of contents

- [What is NetPro?](#what-is-netpro)
- [Feature highlights](#feature-highlights)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [The web UI](#the-web-ui)
- [Where each capability lives](#where-each-capability-lives)
- [CLI reference](#cli-reference)
- [HTTP API](#http-api)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Privacy & security model](#privacy--security-model)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Project status](#project-status)
- [Documentation](#documentation)
- [License](#license)

---

## What is NetPro?

NetPro turns your **LinkedIn connections export** into a private, queryable
network database and then gives you the tools a paid social network hides behind
a subscription:

| Question | NetPro's answer |
| --- | --- |
| Who do I know, and who's gone quiet? | CRM contacts, relationship scores, dormancy analysis |
| How do I find a specific person? | Hybrid search — substring + full-text + optional semantic, fused with RRF |
| Who are the hubs, brokers and communities? | Louvain communities, degree & Brandes betweenness, components |
| Who can introduce me to *X*? | Pathfinder: ranked warm-intro chains **and the first ask to make** |
| Who should I reach out to, and what do I say? | Follow-up reminders + BYO-key AI drafting (drafts only — you send) |
| Where should I go next? | Event matcher and event recommendations from attendee lists |
| Is my writing landing? | Content tracker with metric snapshots and mentions |
| What are we collectively missing? | Skills gap analyzer against a target role |

**Design principles**

1. **Local-first.** `netpro init` creates `~/.netpro` (config, SQLite database,
   logs, keys) and `netpro serve` runs the whole application on
   `http://127.0.0.1:3777`. There is no cloud account, no hosted platform and no
   GitHub OAuth anywhere in the stack.
2. **Everything is optional except the app.** OpenAI/Anthropic (AI drafts),
   Hunter.io/People Data Labs/Clearbit (enrichment) and embedding providers are
   **bring-your-own-key enhancements**. With none configured, NetPro still
   imports, indexes, searches, analyses, scores and reminds.
3. **NetPro drafts; a human sends.** No SMTP, no stored mailbox credentials, no
   background sending. Outreach and campaigns produce messages you review, send
   from your own mail client, and then record.
4. **One implementation, many interfaces.** Every long-running operation is one
   `@netpro/core` function → one job → one SSE event stream → consumed by the
   CLI, the HTTP API and the web UI. Nothing is reimplemented in a UI layer.
5. **Postgres when you need it.** SQLite is the default dialect; PostgreSQL is an
   explicit, first-class deployment option for Docker, teams and servers.

---

## Feature highlights

### Own and query your data

- **LinkedIn CSV import** with dedup/merge, row-level validation and a
  `--preview` mode that reports exactly which rows an import would skip.
  The `Connected On` date is preserved, so growth reflects when relationships
  actually formed.
- **Portable export** to CSV.
- **Dual dialect storage** — SQLite (`~/.netpro/netpro.db`, WAL mode) by default;
  PostgreSQL via config or `DATABASE_URL`. Portable SQL everywhere, no
  `pgvector` requirement.
- **Backup & restore** — `netpro backup` / `netpro restore` (SQLite snapshot or
  `pg_dump`, with a pre-restore safety copy).

### Search that explains itself

- **Three-arm search engine**: portable substring (always on), keyword full-text
  (SQLite FTS5 / Postgres `tsvector` over the *whole* contact document — notes,
  tags, industry, seniority, department, country) and an opt-in embedding arm,
  fused with **reciprocal rank fusion** (k=60).
- Facets, pagination, sorting (relevance / score / recent / name) and filters for
  company, role, location, industry, seniority, email, relationship score,
  activity window, tags, skills and Louvain community.
- **`--explain`** tells you *why* each result matched (`matchReasons`).
- Configure nothing and nothing changes: no index → substring search, no key →
  no semantic arm, provider down → keyword results with a stated reason.

### Network intelligence

- **Analytics overview** — network health score, activity/dormancy breakdown,
  12-month growth, industry/company diversity (Shannon entropy), company
  clusters and the dormant-ties reconnect list.
- **Graph engine** — Louvain community detection, degree + Brandes betweenness
  centrality, connected components, average path length, and a BFS **pathfinder**
  ranked by relationship strength (0.6 × weakest tie + 0.4 × mean hop strength).
- **Edge provenance** — every relationship carries `source`, `confidence` and a
  `status`; inferred edges (CSV mutuals, event attendance) land **pending** and
  are excluded from analysis until you confirm them.
- **Pathfinder** names the intermediary, shows each hop's recency and score, and
  with `--draft` hands the first ask to the AI composer.

### Keep relationships alive

- **CRM** — a per-contact interaction history (email, meeting, call, note,
  LinkedIn message, intro) with a documented **relationship score**:
  recency 40% / frequency 25% / depth 20% / richness 15%, recomputed on every
  logged interaction.
- **Follow-up reminders** with due/overdue/upcoming views, completion, snooze,
  cancel, optional recurrence, and assignment to a teammate.
- **Unified timeline** per contact — profile, stats, interactions, follow-ups.

### Outreach that stays yours

- **AI outreach drafting** (OpenAI-compatible or Anthropic, over plain `fetch`,
  no SDKs) for a contact or an ad-hoc recipient, with tone, context and ask.
- **Batch campaigns** — whitelisted merge variables (`{{firstName}}`,
  `{{company}}`, …), multi-step drip sequences with per-step delays, recipient
  snapshots from a list or a saved search, lifecycle
  (draft → active → paused/completed/archived) and a per-day send limit.
  Every confirmed send is logged as a real interaction (feeding the relationship
  score); a recorded reply cancels the remaining drip.

### Observe the network

- **Skills gap analyzer** — an embedded, explainable taxonomy (101 skills across
  12 categories, with aliases and adjacent-skill rules) extracts skills from
  headlines, roles, tags, custom fields and notes, each hit carrying its field
  and snippet as evidence.
  Compare a target role / job description / skill list against one contact or the
  whole network: present, partial, missing, match score and per-skill coverage.
  Offline by default; the AI pass is opt-in per run and may only pick from the
  taxonomy.
- **Event matcher** — import conference CSVs (alias-tolerant headers), match each
  attendee against your contacts in three explainable tiers (exact email 1.0,
  exact name 0.9, last name + first initial 0.6 — reported but never linked
  without asking), and `recommend` where to go next with a stated reason per
  score. Unresolved attendees are parked so you can re-match after new imports.
- **Content tracker** — canonical URL identity, CSV/RSS-Atom import, engagement
  snapshots over time, mention links and windowed overviews. `manual` and `rss`
  providers ship enabled; `devto`/`twitter`/`github` are self-explaining disabled
  stubs.
- **Profile-view analytics** — a privacy-hardened data model: daily-salted HMAC
  viewer hashes (never raw IPs), a vendored bot deny-list, dedup windows,
  owner-view labelling and a 90-day raw-row purge.

### Work as a team, extend the platform

- **Workspaces & roles** — owner > admin > member > viewer, a break-glass owner
  that cannot be removed, a last-owner guard, workspace-scoped queries across
  every core module, authorship stamps, invite links and an audit log.
- **Encrypted key vault** — workspace-scoped provider credentials encrypted at
  rest with AES-256-GCM and principal/slot-bound key derivation (schema +
  `@netpro/core/crypto` module).
- **Plugins** — strict manifests (npm-style names, semver, engine ranges,
  capability allow-list, exact-host network allow-list), an ESM loader, a
  per-workspace registry of enrichers / AI providers / content providers / event
  discovery / commands, and a `fetch` wrapper that blocks undeclared hosts.
  Plugins install **disabled** and require an explicit permissions review.
- **Self-hosted marketplace** — a static `marketplace/index.json` (schema 1) with
  sha256 checksums, hardened tarball extraction (rejects symlinks, absolute
  paths, `..` escapes, oversized archives), manifest-matches-index verification
  and install-over updates. Point `MARKETPLACE_INDEX_URL` at your own mirror.
- **Outbound webhooks** — an 18-event catalog, HMAC-SHA256 signatures
  (`t=<unix>,v1=<hmac>`, 5-minute tolerance), an SSRF guard on every delivery
  attempt, a 10 s timeout with ≤3 re-validated redirects, exponential backoff
  (60 s → 32 min, 8 attempts), a delivery log with redelivery, and a 30-day
  purge. Outbound only.
- **Daily retention job** — at most one run per 24 h, decided by the data (not a
  cron table), audited in `activity_log`: raw profile views (90 d), content
  metric snapshots (365 d — the latest per piece always survives) and webhook
  deliveries (30 d).

---

## Architecture

```mermaid
flowchart TB
  subgraph clients["Interfaces"]
    CLI["apps/cli<br/>netpro CLI · 27 commands"]
    WEB["apps/web<br/>Next.js 16 Web UI<br/>(pure client, no DB, no API routes)"]
  end

  SERVER["packages/server<br/>node:http — REST API, auth, jobs, SSE<br/>127.0.0.1:3777"]

  CORE["packages/core<br/>ALL business logic:<br/>import · search · graph · CRM · AI · views · content · skills · events<br/>campaigns · workspaces · plugins · webhooks · retention"]

  DB["packages/db<br/>Drizzle schema · migrations<br/>dual dialect"]

  SQLITE[("SQLite<br/>~/.netpro/netpro.db<br/>(default)")]
  PG[("PostgreSQL<br/>Docker / team / remote")]
  KEYS["~/.netpro/keys<br/>access token (0600) · CLI keychain"]
  PROV["Optional BYO-key providers<br/>OpenAI · Anthropic<br/>Hunter · PDL · Clearbit · embeddings"]

  CLI -->|"in-process commands"| CORE
  CLI -->|"serve / scan delegation"| SERVER
  WEB -->|"HTTP + SSE"| SERVER
  SERVER --> CORE
  CORE --> DB
  DB --> SQLITE
  DB --> PG
  CLI -.-> KEYS
  CORE -.->|"only when configured"| PROV

  classDef optional stroke-dasharray: 5 5;
  class PROV optional;
```

**The dependency rule is one-way and enforced in CI:**

```text
packages/db  →  packages/core  →  packages/server  →  apps/web
                                 ↘  apps/cli
```

`@netpro/core` holds every business rule. `@netpro/server` orchestrates it behind
HTTP, auth, jobs and SSE. `apps/web` renders what the server returns — it never
opens a database, never duplicates search or graph logic and performs no
authentication of its own.

**One operation → one job → one event stream → many interfaces.** A scan started
as `netpro scan` in a terminal and a scan started from the web UI's Scan page are
the same `runScan()` implementation, the same `Job`, and the same SSE events:

```mermaid
sequenceDiagram
  autonumber
  participant T as Terminal
  participant S as packages/server
  participant J as Job registry
  participant C as packages/core
  participant W as Web UI

  T->>S: POST /api/scan
  S->>J: create job (queued, 0%)
  J-->>W: event job.queued
  S->>C: runScan() — reindex + enrich + graph
  C-->>S: progress updates
  S-->>W: scan.progress (15 → 40 → 70 → 90%)
  C-->>S: result snapshot
  S->>J: completed (100%)
  J-->>W: event job.completed
  T->>S: GET /api/jobs/:id
  S-->>T: job + result
```

Scan stages: `queued → discovering → processing → enriching → indexing → completed`.
Every step is best-effort by design — a scan with no providers configured, or on
an un-migrated database, still completes and still reports real numbers.

---

## Quickstart

**Prerequisites:** Node.js ≥ 20. Nothing else — no Docker, no database server, no
account.

```bash
# Install the CLI from the v3.0.0 release bundle
npm install -g https://github.com/NiravRVaghasiya/NetPro/releases/download/v3.0.0/netpro-3.0.0.tgz

netpro init       # creates ~/.netpro: config.toml, SQLite db, logs, keys
netpro serve      # http://127.0.0.1:3777 (foreground; Ctrl+C stops it)
netpro status     # install · database · identity · server health · providers
```

> The unscoped npm name `netpro` belongs to an unrelated package, so the CLI is
> distributed as the installable tarball attached to each
> [release](https://github.com/NiravRVaghasiya/NetPro/releases/latest) instead of
> from the npm registry — the tarball installs the same `netpro` binary, with its
> bundled server, migrations and native drivers. The source-checkout and Docker
> paths below are unaffected. See [`docs/releasing.md`](docs/releasing.md).

`netpro init` output on a fresh machine:

```text
NetPro initialized

Created /home/you/.netpro
Database: SQLite — /home/you/.netpro/netpro.db (15/15 migrations applied)
Server:   127.0.0.1:3777
Config:   /home/you/.netpro/config.toml (created)
Identity: ins_f73d12621d35deb56159f85a (you) — created
Token:    np_N4h…b_kg at /home/you/.netpro/keys/access-token (created)
```

Then use the same local database from another terminal:

```bash
netpro import ~/Downloads/Connections.csv   # LinkedIn export
netpro search "AI founders"                 # hybrid-capable search
netpro analyze                              # score, growth, clusters, dormant ties
netpro scan                                 # reindex + enrich + graph in one sweep
```

### From a source checkout

```bash
git clone https://github.com/NiravRVaghasiya/NetPro.git
cd NetPro
npm install
npm run build

node apps/cli/dist/index.js init
node apps/cli/dist/index.js serve      # API + built-in console at :3777
node apps/cli/dist/index.js --help     # the full command surface
```

Run the web UI against the running server:

```bash
cp apps/web/.env.example apps/web/.env.local   # defaults to http://127.0.0.1:3777
npm run dev -w apps/web                        # http://localhost:3000
```

> The web UI is a **pure client**: it opens no database and serves no API of its
> own. If the server is not running, every page says so and renders an empty
> shell instead of failing.

---

## The web UI

Ten server-backed pages plus a landing page, all rendered from the local NetPro
server (SQLite or Postgres — the UI cannot tell the difference):

| Page | What it shows | Server calls |
| --- | --- | --- |
| `/` | Local-first on-ramp: what NetPro is, links into the app | — |
| `/observatory` | Network size, relationships, communities, jobs, last scan, index & provider status, live activity | `GET /api/analytics`, `/api/graph`, `/api/jobs`, `/api/providers`, SSE `/api/events` |
| `/network` | Force-directed graph, communities, hubs, bridges; with `?target=` the ranked warm-intro chains | `GET /api/graph`, `/api/graph/visualization`, `/api/graph/path` |
| `/search` | Hybrid search with filters, facets, engine badge and per-hit “why this matched” | `GET /api/search` |
| `/pathfinder` | “Who can introduce me to X?” — ranked chains as a hop-by-hop stepper, first ask included | `GET /api/graph/path` |
| `/people` | CRM list sorted by recency, score, name or follow-up | `GET /api/contacts` |
| `/people/[id]` | Read-only contact timeline: profile, stats, interactions, pending follow-ups | `GET /api/contacts/:id` |
| `/activity` | Live SSE feed of `job.*` / `scan.*` / `import.*` / `relationship.discovered`, plus the jobs table and progress ladder | `GET /api/jobs`, SSE `/api/events` |
| `/scan` | Scan visualisation: source, progress, processed counts, new/updated contacts, edges discovered, enrichment; start a sweep from the UI | `POST /api/scan`, `GET /api/jobs` |
| `/import` | Upload → preview/validate → import, with live job progress | `POST /api/import/preview`, `POST /api/import` |
| `/settings` | Installation identity, auth mode, provider status and what each unconfigured provider would enable | `GET /api/identity`, `/api/providers` |

Everything else NetPro can do — CRM writes, campaigns, cards, skills, events,
content, teams, plugins, webhooks — is available through the CLI and, where noted
below, the HTTP API. Those pages were intentionally removed in the local-first
cleanup so the server, not the UI, owns authentication and data access.

---

## Where each capability lives

| Capability | `core` | CLI | HTTP API | Web UI |
| --- | :-: | --- | --- | :-: |
| LinkedIn import + preview | ✅ | `netpro import` | `POST /api/import`, `/api/import/preview` | ✅ |
| Scan (reindex + enrich + graph) | ✅ | `netpro scan` | `POST /api/scan` | ✅ |
| Contact enrichment (BYO key) | ✅ | `netpro enrich` | `POST /api/enrich` | — |
| Search (portable / keyword / hybrid) | ✅ | `netpro search` | `GET /api/search` | ✅ |
| Reindex & embeddings | ✅ | `netpro reindex` | — | — |
| Analytics overview | ✅ | `netpro analyze` | `GET /api/analytics` | ✅ |
| Graph analytics | ✅ | `netpro analyze --graph` | `GET /api/graph*` | ✅ |
| Pathfinder + first ask | ✅ | `netpro path [--draft]` | `GET /api/graph/path(s)` | ✅ |
| CRM reads (contacts, timeline) | ✅ | `netpro track list` | `GET /api/contacts[/:id]` | ✅ |
| CRM writes (interactions, follow-ups) | ✅ | `netpro track log/add/done/…` | — | — |
| AI outreach drafting | ✅ | `netpro outreach` | — | — |
| Batch campaigns | ✅ | `netpro campaign` | — | — |
| Profile card (HTML / vCard) | ✅ | `netpro card` | — | — |
| Profile-view analytics | ✅ | `netpro card --views`, `netpro analyze --views` | `views` block of `/api/analytics` | — |
| Skills gap analyzer | ✅ | `netpro skills` | — | — |
| Event matcher & recommendations | ✅ | `netpro events` | `GET /api/events` (list/detail) | — |
| Content tracker | ✅ | `netpro content` | `content` block of `/api/analytics` | — |
| Workspaces & team | ✅ | `netpro team` | — | — |
| Plugins & marketplace | ✅ | `netpro plugin` | — | — |
| Outbound webhooks | ✅ | `netpro webhook` | — | — |
| Encrypted key vault | ✅ | — | — | — |
| Backup / restore | — | `netpro backup`, `netpro restore` | — | — |
| Jobs & live events | ✅ | job output | `GET /api/jobs`, SSE `/api/events` | ✅ |
| Provider status | ✅ | `netpro status` | `GET /api/providers` | ✅ |

---

## CLI reference

`netpro` is the primary interface. Every command supports `--help`; most accept
`--json` for scripting. A global `--workspace <id>` selects the workspace for the
invocation (precedence: flag → `NETPRO_WORKSPACE` → config → bootstrap
workspace).

### Command map

| Command | What it does |
| --- | --- |
| `netpro init` | Create `~/.netpro`, the installation identity and the database |
| `netpro serve` | Run the local server + built-in console (`127.0.0.1:3777`) |
| `netpro status` | Install, database, identity, server health and provider status |
| `netpro token` | Show / `--rotate` the access token used for remote callers |
| `netpro config` | Manage configuration; API keys are stored encrypted via `set/get/delete/list` |
| `netpro import [file]` | Import a LinkedIn connections CSV (`--preview` validates without writing) |
| `netpro scan` | One observable sweep: reindex + enrichment + graph analysis |
| `netpro enrich` | Enrich contacts via Hunter / PDL / Clearbit (`--source`, `--force`) |
| `netpro search [query]` | Faceted search (`--mode portable\|keyword\|hybrid`, `--explain`, `--skills`, `--community`, …) |
| `netpro reindex` | Rebuild the full-text index (`--embeddings`, `--status`, `--force`) |
| `netpro outreach` | Draft an AI-composed message — NetPro drafts, you send |
| `netpro analyze` | Network score, growth, diversity, clusters, dormant ties, graph, views |
| `netpro path <target>` | Ranked warm-intro chains and the first ask (`--draft` composes it) |
| `netpro track` | CRM interactions and follow-ups |
| `netpro edge` | Graph edge provenance: add, list, import, merge, confirm, reject |
| `netpro campaign` | Draft and manage batch campaigns — no sending |
| `netpro export` | Export contacts as CSV |
| `netpro card` | Generate a portable HTML card or vCard; `--views` shows profile-view analytics |
| `netpro migrate` | Apply pending migrations (`--status`, `--no-backup`) |
| `netpro backup` / `restore` | Database backups (`--list`, `--output`, `--force`) |
| `netpro skills` | Skills derivation and gap analysis against a target role |
| `netpro events` | Event matcher: import, match, link, recommend |
| `netpro content` | Cross-posting tracker: add, import (CSV/RSS), fetch, analyze |
| `netpro team` | Workspace members, invites and roles |
| `netpro plugin` | Plugin install / enable / disable / settings + marketplace search |
| `netpro webhook` | Outbound webhooks: add, deliveries, test, redeliver, retry |

### Subcommand groups

```text
netpro track     log <contact> · add <contact> · list · done <id> · snooze <id>
                 · cancel <id> · assign <id>
netpro edge      add <from> <to> · list · rm <id> · import <csv> · merge
                 · confirm <id> · reject <id>
netpro campaign  list · create · add-recipients <id> · show <id> · activate
                 · pause · complete · archive · mark-sent · mark-replied · mark-skipped
netpro skills    gap · extract · status
netpro events    list · show · add · import <csv> · match · link · unlink
                 · recommend · rm
netpro content   list · add <url> · show · import [file|feed] · fetch · rm · analyze
netpro team      list · invite · revoke · add · rm · role <user> <role>
netpro plugin    list · paths · discover · search · info · install · update
                 · enable · disable · rm · settings
netpro webhook   list · events · add <url> · rm · enable · disable · rotate
                 · deliveries · test · redeliver · retry
netpro config    set <key> <value> · get <key> · delete <key> · list
```

### A concrete session

```bash
# 1. own the data
netpro init
netpro import ~/Downloads/Connections.csv

# 2. make it searchable and analysed in one sweep
netpro scan

# 3. ask questions
netpro search "founder" --industry "software" --active-within 180 --explain
netpro analyze --network-score
netpro analyze --graph --limit 5
netpro path "Ada Lovelace" --draft

# 4. keep the relationship alive
netpro track log ada@example.com --type email --direction outbound --note "Sent the deck"
netpro track add ada@example.com --met-at "NeurIPS 2026" --follow-up 2w
netpro track list --overdue

# 5. reach out, one at a time or at scale
netpro outreach --to ada@example.com --tone warm --purpose "a 15-minute call about OSS collab"
netpro campaign create --name "Q3 reconnects" \
  --subject "Good to see your name again, {{firstName}}" \
  --body "Hi {{firstName}}, it has been a while since {{company}}…"
netpro campaign add-recipients q3-reconnects --query "founder" --industry "software"
```

---

## HTTP API

`netpro serve` (or `node packages/server/dist/bin.js`) exposes a JSON API over
`node:http` — no framework. `/api/health` and `/api/server-info` are public; every
other route requires the local operator (loopback in `local` mode, a bearer token
otherwise). Errors are JSON, never HTML.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Readiness probe: `healthy` (200) · `degraded` (503, migrations missing) · `unhealthy` (503) |
| `GET` | `/api/server-info` | Service identity and auth mode |
| `GET` | `/api/identity` | Installation id, auth mode and token presence (never the token) |
| `GET` | `/api/contacts` | CRM contact list (`sort=recent\|score\|name\|follow-up`) |
| `GET` | `/api/contacts/:id` | Contact timeline: profile, stats, interactions, follow-ups |
| `GET` | `/api/search` | Search (`mode=portable\|keyword\|hybrid`, all filters, facets) |
| `GET` | `/api/graph`, `/api/graph/overview`, `/api/graph/network` | Communities, centrality, components, warm-intro candidates |
| `GET` | `/api/graph/path`, `/api/graph/paths` | Ranked intro chains to `?target=` |
| `GET` | `/api/graph/visualization` | Node/link payload for the graph view |
| `GET` | `/api/analytics` | Full overview: metrics, score, growth, clusters, dormant, graph, views, content |
| `POST` | `/api/import` | Import (multipart, JSON `{csv}` or `text/csv`) → creates an import job |
| `POST` | `/api/import/preview` | Parse + validate without writing |
| `GET` | `/api/import/:id` | Import job status |
| `POST` | `/api/scan` | Start a scan job with the 15 → 40 → 70 → 90 → 100 progress ladder |
| `POST` | `/api/enrich` | Start an enrichment job |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Job registry (`?type=&status=&limit=&offset=`) |
| `POST` | `/api/jobs/:id/cancel` | Cancel a queued/running job |
| `GET` | `/api/events` | **SSE** with `Accept: text/event-stream`; otherwise calendar-event JSON |
| `GET` | `/api/events/stream` | SSE alias (always a stream) |
| `GET` | `/api/events/:id` | Event detail |
| `GET`/`PUT` | `/api/settings` | Server, database, auth and installation settings |
| `GET` | `/api/providers` | Which optional providers are configured, into which category |
| `GET` | `/` | Built-in local console (loopback only; names the database) |

**Jobs** are the contract between interfaces:

```ts
type Job = {
  id: string;
  type: 'import' | 'scan' | 'enrich' | 'index' | 'embed' | 'graph' | 'analyze';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;                 // 0–100
  metadata: Record<string, unknown>;
  error: string | null;
  startedAt / completedAt / createdAt / updatedAt: string | null;
};
```

**SSE** example:

```text
retry: 3000
: connected

event: scan.progress
data: {"type":"scan.progress","jobId":"…","progress":40,"message":"Processing contacts","seq":12,"timestamp":"…"}
```

Hardening applied to every response: request ids, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, an optional HSTS switch, an origin
allow-list for CORS (loopback by default) and a per-IP rate limit (600/min by
default) that returns `429` with `Retry-After`.

---

## Data model

27 tables per dialect, defined once in Drizzle
([`packages/db/src/schema.sqlite.ts`](packages/db/src/schema.sqlite.ts) /
[`schema.pg.ts`](packages/db/src/schema.pg.ts)) and applied by **15 mirrored
migrations per dialect** (`0000`–`0014`).

```mermaid
erDiagram
  workspaces ||--o{ workspace_members : "has"
  workspaces ||--o{ workspace_invites : "issues"
  workspaces ||--o{ contacts : "scopes"
  contacts ||--o{ interactions : "logs"
  contacts ||--o{ follow_ups : "schedules"
  contacts ||--o{ enrichments : "provenance"
  contacts ||--o| search_index : "indexed as"
  contacts }o--o{ edges : "linked by"
  events ||--o{ event_attendees : "attended"
  contacts ||--o{ event_attendees : "matched to"
  campaigns ||--o{ campaign_recipients : "targets"
  contacts ||--o{ campaign_recipients : "personalized for"
  content_items ||--o{ content_metrics : "snapshots"
  content_items ||--o{ content_mentions : "mentioned by"
  contacts ||--o{ content_mentions : "matched to"
  contacts ||--o{ profile_views : "viewed by"
  workspaces ||--o{ webhooks : "owns"
  webhooks ||--o{ webhook_deliveries : "delivers"
  workspaces ||--o{ plugins : "registers"
  workspaces ||--o{ key_vault : "encrypts"
  workspaces ||--o{ activity_log : "audits"
```

| Group | Tables |
| --- | --- |
| Identity & workspaces | `workspaces`, `workspace_members`, `workspace_invites`, `user`, `account`, `session`, `verificationToken` |
| Network | `contacts`, `edges`, `enrichments`, `search_index` |
| CRM | `interactions`, `follow_ups`, `activity_log` |
| Events | `events`, `event_attendees` |
| Content | `content_items`, `content_metrics`, `content_mentions` |
| Campaigns | `campaigns`, `campaign_recipients` |
| Privacy | `profile_views`, `profile_cards` |
| Platform | `plugins`, `webhooks`, `webhook_deliveries`, `key_vault` |

Migration history: `0000` base schema · `0001` profile card · `0002` CRM indexes ·
`0003` edge provenance · `0004` hybrid search (FTS5 / `tsvector` + GIN) ·
`0005` skills · `0006` view privacy · `0007` content tracker · `0008` workspaces ·
`0009` key vault · `0010` authorship · `0011` workspace defaults · `0012` team
collaboration · `0013` plugins · `0014` webhooks. All are additive and idempotent;
concurrent cold starts are serialised with a Postgres advisory lock.

---

## Configuration

Everything NetPro stores lives in one directory, `~/.netpro` by default
(relocate the whole install with `NETPRO_HOME`):

```text
~/.netpro/
├── config.toml    # user-editable configuration + this install's identity
├── netpro.db      # SQLite database (the default dialect)
├── backups/       # netpro backup output
├── logs/          # install logs
└── keys/          # credentials.enc (CLI keychain) · access-token (mode 0600)
```

```toml
[database]
# dialect = "sqlite"              # "sqlite" (default) or "postgresql"
# path = "~/.netpro/netpro.db"
# url = "postgresql://…"          # required when dialect = "postgresql"

[server]
# host = "127.0.0.1"              # loopback by default — expose deliberately
# port = 3777

[auth]
# mode = "local"                  # local (default) | token | open

[installation]                    # written by netpro init; no need to edit
id = "ins_…"
created_at = "…"
```

Precedence for every setting: **CLI flags → environment → `config.toml` →
defaults**. The config parser accepts the documented TOML subset and fails loudly
with a line number instead of silently ignoring a typo.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NETPRO_HOME` | `~/.netpro` | Install directory (config, database, logs, keys) |
| `DB_DIALECT` | `sqlite` | `sqlite` or `postgresql` — never inferred |
| `DB_PATH` | `<home>/netpro.db` | SQLite file path |
| `DATABASE_URL` | — | Postgres connection string |
| `NETPRO_SERVERLESS` | — | `1` → one DB connection per instance (scaled-out deployments) |
| `NETPRO_DB_POOL_MAX`, `NETPRO_DB_SSL_CA` | — | Pool sizing and strict TLS verification |
| `NETPRO_HOST` / `HOST`, `NETPRO_PORT` / `PORT` | `127.0.0.1`, `3777` | Server bind |
| `NETPRO_AUTO_MIGRATE` | `true` | Apply pending migrations on server start |
| `NETPRO_AUTH_MODE` | `local` | `local` \| `token` \| `open` |
| `NETPRO_AUTH_TOKEN` | — | Access token for remote callers (else `~/.netpro/keys/access-token`) |
| `NETPRO_ALLOWED_ORIGINS` | loopback | CSV origin allow-list for browser callers |
| `NETPRO_RATE_LIMIT_MAX`, `_WINDOW_MS`, `_ENABLED` | `600`, `60000`, on | Per-IP rate limit |
| `NETPRO_HSTS` | off | Send `Strict-Transport-Security` behind a TLS proxy |
| `HUNTER_API_KEY`, `PDL_API_KEY`, `CLEARBIT_API_KEY` | — | Contact enrichment |
| `AI_PROVIDER`, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL` | — | AI drafting |
| `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_API_KEY`, `_MODEL`, `_BASE_URL`, `_DIMENSIONS` | disabled | Semantic search arm |
| `NETPRO_VIEW_SALT` | built-in | Base salt for viewer hashing |
| `NETPRO_DISABLE_VIEWS` | — | `true` → beacons answer but write no rows |
| `NETPRO_DISABLE_RETENTION` | — | `true` → no purge ever runs |
| `NETPRO_VIEW_RETENTION_DAYS`, `NETPRO_CONTENT_METRIC_RETENTION_DAYS`, `NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS` | `90`, `365`, `30` | Retention windows |
| `ENCRYPTION_MASTER_KEY` | — | ≥32 chars; unlocks the encrypted web key vault |
| `MARKETPLACE_INDEX_URL`, `NETPRO_PLUGIN_DIR`, `MARKETPLACE_NO_CACHE` | this repo, `./plugins`, 1 h cache | Plugin marketplace |
| `NETPRO_WEBHOOKS_ALLOW_PRIVATE` | — | `1` allows webhooks to localhost/LAN receivers |
| `NETPRO_SERVER_URL` / `NEXT_PUBLIC_NETPRO_SERVER_URL` | `http://127.0.0.1:3777` | Web UI → server address |
| `NETPRO_AUTH_TOKEN` / `NEXT_PUBLIC_NETPRO_AUTH_TOKEN` | — | Token the web UI presents when the server requires one |

### Authentication modes

| Mode | Who gets in |
| --- | --- |
| `local` *(default)* | Requests whose socket peer is loopback and that did not arrive through a proxy are the operator, identified by `~/.netpro/config.toml`. Everyone else needs the access token (`netpro token`). |
| `token` | Every caller, loopback included, presents `Authorization: Bearer <token>`. |
| `open` | NetPro authenticates nobody — only correct behind your own auth (reverse proxy with sign-in, VPN, private network). |

No mode uses GitHub OAuth, cookies or third-party sign-in.

---

## Deployment

Two supported shapes, both documented in
[`docs/deployment.md`](docs/deployment.md):

| Target | Database | Best for |
| --- | --- | --- |
| Local (`netpro init` + `netpro serve`) | SQLite file in `~/.netpro` | Everyday use — no credentials, no cloud |
| Docker Compose / any Node host | PostgreSQL | A server you own: remote access, a team, a VPS |

### Docker Compose

```mermaid
flowchart LR
  subgraph host["Your host (ports published on 127.0.0.1 by default)"]
    WEB["web<br/>Next.js standalone<br/>:3000"]
    SRV["server<br/>@netpro/server<br/>:3777"]
    MIG["migrate (one-shot)<br/>netpro migrate"]
    DB[("db<br/>postgres:16-alpine<br/>volume: postgres_data")]
    VOL[("plugins volume")]
  end
  BROWSER["Browser"] --> WEB
  WEB -->|"NETPRO_SERVER_URL=http://server:3777"| SRV
  SRV --> DB
  SRV --- VOL
  MIG --> DB
  SRV -. "depends_on: healthy" .- MIG
  SRV -. "depends_on: healthy" .- DB
```

```bash
cp .env.example .env          # set POSTGRES_PASSWORD (and auth mode)
docker compose up -d          # migrate → server → web
curl http://127.0.0.1:3777/api/health
```

The image ships three roles from one build: the standalone API server, the
pure-client web UI, and the CLI used by the migration job. Postgres is **not**
published to the host by default, and both app ports bind to loopback unless you
change them.

### Any Node host

```bash
npm ci
npm run build
export DB_DIALECT=postgresql
export DATABASE_URL='postgresql://user:pass@host:5432/netpro?sslmode=require'
npm run db:migrate            # apply migrations as an explicit release step
npm run start -w apps/web     # or: node packages/server/dist/bin.js for the API
```

Health semantics for orchestrators: `healthy` (200) = database reachable and
fully migrated; `degraded` (503) = reachable with pending migrations;
`unhealthy` (503) = unreachable. `/api/health` is public by design so a probe
works before any credential exists.

---

## Privacy & security model

- **Local by default.** The server binds `127.0.0.1`; binding to `0.0.0.0`
  requires an explicit setting, prints a warning naming what is now reachable, and
  ensures a remote access token exists.
- **No telemetry, no third-party scripts, no cookies** in the observer features.
  Provider calls happen only when you configure a key and run the command —
  never in the background during import.
- **Viewer privacy by construction.** Viewer identifiers are HMAC-SHA256 digests
  under a daily-rotating salt truncated to 64 bits; raw IPs are never stored, bot
  traffic is filtered by a vendored deny-list, and raw rows are purged after
  90 days.
- **Secrets never surface.** Provider keys live in the environment or the
  encrypted CLI keychain and are never printed by any interface; the key vault
  returns masked values only; webhook secrets are shown exactly once on rotation.
- **Webhook egress guard.** Private-network targets (loopback, RFC 1918,
  link-local cloud-metadata addresses, IPv6 ULA/link-local, `*.internal`) are
  refused at creation *and* re-checked on every delivery and every redirect hop.
  Deliberate local receivers opt in with `NETPRO_WEBHOOKS_ALLOW_PRIVATE=1`.
- **Plugins are gated.** Manifests declare capabilities and an exact host
  allow-list; undeclared hosts are blocked and audited; a crashing plugin is
  isolated and disabled instead of taking the process down; enabling requires an
  explicit permissions review.
- **Marketplace integrity.** Static index, sha256 verification (mismatch is a
  hard refusal), hardened tar extraction, and installation always lands
  **disabled**.
- **Web hardening.** Request ids, security headers, origin allow-listing,
  per-IP rate limiting, bounded request bodies and JSON-only API errors.

---

## Repository layout

```text
NetPro/
├── apps/
│   ├── cli/                 # `netpro` — commander CLI (tsup bundle, 27 commands)
│   └── web/                 # Next.js 16 App Router UI — pure client of the server
├── packages/
│   ├── core/                # ALL business logic (search, graph, CRM, AI, views,
│   │                        #  content, skills, events, campaigns, plugins, webhooks)
│   ├── server/              # node:http API, auth, jobs, SSE, security middleware
│   ├── db/                  # Drizzle schema (SQLite + Postgres) and migrations
│   └── config/              # shared ESLint + Tailwind configs
├── docs/                    # getting-started, local-first, deployment, webhooks,
│                            # releasing, per-release notes, example profile JSON
├── marketplace/             # self-hosted plugin index + reference tarball
├── plugins/                 # in-tree reference plugin (example-event-discovery)
├── scripts/                 # package check + CLI/server/web smoke tests
├── Dockerfile               # three roles, one image
├── docker-compose.yml       # migrate → server → web + Postgres
└── .github/workflows/       # ci.yml (the gate) · release.yml (tag → release)
```

---

## Development

```bash
npm install          # Node ≥ 20; npm workspaces + Turborepo
npm run build        # build every workspace
npm run lint         # ESLint across the monorepo
npm run typecheck    # tsc --noEmit everywhere
npm test             # hermetic vitest suites (real scratch SQLite files, not mock SQL)
npm run test:pg      # PostgreSQL integration suites (needs a live database)
npm run smoke        # CLI + installed package + server + web UI smokes against shipped artifacts
npm run dev          # workspace dev scripts
```

Current local run (Node 22.22.3): **1,650 tests passing** in 136 test files —
CLI 363, core 998, db 123, server 136, web 30 — with **60 PostgreSQL-backed tests skipped** because
no `NETPRO_TEST_DATABASE_URL` was present; those run in CI against a real
Postgres server. Measured performance budgets also ship as tests (graph analytics
at 3,000 nodes / 8,000 edges, skills extraction at 5,000 contacts, search and
view/content pipelines).

### CI pipeline

```mermaid
flowchart LR
  A["Install<br/>npm ci"] --> B["Lint & typecheck<br/>Node 20 + 22"]
  B --> C["Unit tests<br/>(hermetic, SQLite)"]
  C --> D["SQLite integration<br/>+ marketplace e2e"]
  D --> E["PostgreSQL integration<br/>+ performance pass"]
  E --> F["Build all workspaces<br/>+ package checks<br/>(bundled + installed)"]
  F --> G["CLI smoke"]
  G --> H["Server smoke<br/>SQLite + PostgreSQL"]
  H --> I["Web UI smoke<br/>(standalone build)"]
  I --> J["Docker e2e<br/>Postgres + server + web"]
```

The gate proves the published shape, not just compilation: migrations apply
twice as a no-op, `token` mode answers `401` without the token and `200` with it,
the web UI exposes no API or auth surface of its own, and the Docker image runs
the real deploy path end to end.

---

## Project status

**v3.0.0 — “The Platform”** — the
[first tagged release](https://github.com/NiravRVaghasiya/NetPro/releases/tag/v3.0.0)
(2026-09-11) — built on v1.0 (import,
enrichment, export, search, analytics, AI drafts, profile card), v1.5 (CRM
tracking, follow-up reminders, campaigns), v2.0 “The Strategist” (graph engine,
pathfinder, hybrid search, skills, events) and v2.5 “The Observer” (privacy-first
profile views and the content tracker).

**Deliberately deferred** — documented, not forgotten:

- live event-discovery providers (the interface ships, disabled);
- a native `pgvector` column + ANN index (embeddings are portable JSON today);
- AI skills extraction as a default (it is opt-in per run);
- real SMTP delivery for campaigns — NetPro drafts, a human sends;
- `$EDITOR` draft review;
- cross-day viewer tracking or stranger deanonymisation (privacy by omission);
- a plugin sandbox — plugins run in-process, which is exactly why the manifest
  network allow-list and the review gate exist;
- a curated plugin store (the marketplace is a checksummed static index);
- a background webhook delivery worker and inbound webhook ingestion;
- web pages for the CLI-only capabilities listed in
  [Where each capability lives](#where-each-capability-lives);
- publishing to the npm registry — the unscoped name is taken, so each release
  ships an installable tarball instead (see [Releasing](#documentation)).

---

## Documentation

| Document | Covers |
| --- | --- |
| [`docs/getting-started.md`](docs/getting-started.md) | Install, first import, authentication modes, running the CLI |
| [`docs/local-first.md`](docs/local-first.md) | The `~/.netpro` install, identity, `serve`, config precedence, one-operation/two-interface design |
| [`docs/deployment.md`](docs/deployment.md) | Postgres, migrations, TLS, pooling, health checks, search engines, retention, remote-exposure checklist |
| [`docs/webhooks.md`](docs/webhooks.md) | Event catalog, signature verification, receiver recipes (Zapier, n8n, Make, Node) |
| [`docs/releasing.md`](docs/releasing.md) | Cutting a release: the tag gate, the installable CLI bundle, notes files, why the npm registry name is not used |
| [`docs/releases/`](docs/releases) | The notes published with each release (`v3.0.0` and later) |
| [`docs/examples/profile.json`](docs/examples/profile.json) | Input shape for `netpro card --generate` |
| [`packages/server/README.md`](packages/server/README.md) | The server's API contract, job model and SSE transport |

---

## License

[MIT](LICENSE) © NetPro Contributors
