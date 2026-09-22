# Phase 0 — Baseline freeze

> Frozen so the Python migration has a known-good TypeScript product to preserve.

## Freeze

| Field | Value |
| --- | --- |
| **Commit** | `19f888c39608864696a720547a17b815a20a89ec` |
| **Message** | `Add files via upload` |
| **Date** | 2026-09-13 (commit); Phase 0 recorded 2026-09-22 |
| **Product version** | **3.0.2** (“The Platform”) |
| **Branch at freeze** | `master` / `arena/01a0c800-netpro` |
| **License** | MIT |
| **Node** | ≥ 20 (CI matrix 20 + 22) |
| **Language mix** | TypeScript 3.1 MB · Shell · JavaScript · Dockerfile · CSS — **no Python yet** |

Git history on `master` is a single snapshot commit (the PR trail of 73 merged PRs still exists on GitHub). Treat this tree, not `git log`, as the source of truth.

Latest published artifact: GitHub Release **v3.0.2** (`netpro-3.0.2.tgz`). v3.0.0 was withdrawn (installed CLI could not find migrations); v3.0.1 made the tarball runnable; v3.0.2 fixed the `netpro serve` banner.

---

## What NetPro is (behaviour to preserve)

A **local-first professional relationship intelligence platform**. Import a LinkedIn connections CSV, get a private graph on the operator’s machine (SQLite default, PostgreSQL first-class), then search, analyze, score, remind, and draft outreach. No telemetry, no OAuth, no SMTP. **NetPro drafts; a human sends.**

Product loop: **Import → Understand → Discover → Maintain → Act.**

---

## Architecture at freeze

```text
packages/db  →  packages/core  →  packages/server  →  apps/web
                                 ↘  apps/cli
```

One-way dependency, enforced by workspace layout and CI. Business rules live **only** in `@netpro/core`. Routes orchestrate. The Web UI is a **pure client** (no DB, no API routes of its own).

```text
CLI (27 commands)  ──in-process──►  @netpro/core
CLI `serve` / `scan` ──HTTP/SSE──►  @netpro/server  ──►  @netpro/core
Web UI (Next.js 16) ──HTTP/SSE──►  @netpro/server  ──►  @netpro/core
@netpro/core ──Drizzle──►  SQLite (~/.netpro/netpro.db)  or  PostgreSQL 16
```

**One operation → one core implementation → one Job → one event stream → many interfaces.**

Default bind: `127.0.0.1:3777`. Remote bind is opt-in and warned. Web UI is a **separate** process (`apps/web`, typically `:3000`).

Install directory (`NETPRO_HOME` or `~/.netpro`):

```text
~/.netpro/
├── config.toml          # [database] [server] [installation] [auth]
├── netpro.db            # SQLite (WAL, 0600)
├── logs/                # 0700
└── keys/
    └── access-token     # 0600, prefix np_
```

---

## Package inventory

| Package | Path | Role | Build |
| --- | --- | --- | --- |
| `@netpro/db` | `packages/db` | Dual-dialect Drizzle schema, 15 migrations/dialect, local install, identity/token, backup/restore, connection factory | `tsc --noEmit` |
| `@netpro/core` | `packages/core` | **All** domain logic | `tsc --noEmit` |
| `@netpro/server` | `packages/server` | `node:http` API, auth, jobs, SSE, `netpro-server` bin | tsup |
| `@netpro/cli` | `apps/cli` | `netpro` CLI (27 commands), bundles server | tsup |
| `@netpro/web` | `apps/web` | Next.js 16 App Router, Tailwind, standalone output | next build |
| `@netpro/config` | `packages/config` | Shared ESLint / Tailwind config | — |

Supporting trees (not npm workspaces):

| Path | Role |
| --- | --- |
| `plugins/example-event-discovery` | Reference plugin (disabled-by-default) |
| `marketplace/` | Static checksummed plugin index + tarball |
| `scripts/smoke/` | CLI / installed-package / local-stack / web-ui smokes |
| `docs/` | Getting started, local-first, deployment, webhooks, releasing |
| `.github/workflows/` | `ci.yml` (9-stage gate), `release.yml` |

### `@netpro/core` modules (authoritative for Python)

| Module | Path | Owns |
| --- | --- | --- |
| Import | `src/import/` | LinkedIn CSV parse, normalize, merge, preview, LinkedIn URL identity |
| Search | `src/search/` | Portable / keyword / hybrid, RRF (k=60), FTS indexer, embeddings JSON, explain |
| Graph | `src/graph/` | Load, Louvain, degree + Brandes, paths, pathfinder ranking, visualization, edge provenance |
| CRM | `src/crm/` | Contacts, interactions, scoring, follow-ups, timeline, add-person |
| Analytics | `src/analytics/` | Metrics, Shannon diversity, growth, clusters, dormant, composite health score |
| Scan | `src/scan/` | One sweep: reindex → optional enrich → graph |
| AI | `src/ai/` | Outreach compose, OpenAI + Anthropic providers, prompt, parser |
| Enrichment | `src/enrichment/` | Pipeline, cache, rate-limit, Hunter / PDL / Clearbit |
| Campaigns | `src/campaigns/` | Draft-only drips, whitelist merge vars, recipient snapshots |
| Skills | `src/skills/` | 101-skill taxonomy, extract, gap |
| Events | `src/events/` | Attendee match tiers, recommendations; discovery **stub** |
| Content | `src/content/` | URL canonicalization, RSS/CSV, metrics; Dev.to/Twitter/GitHub **stubs** |
| Views | `src/views/` | Profile-view hashing, bots, beacon, analytics |
| Card | `src/card/` | HTML card + vCard |
| Workspaces | `src/workspaces/` | Roles, invites, scope guard |
| Crypto | `src/crypto/` | AES-256-GCM vault, provider key slots |
| Plugins | `src/plugins/` | Manifest, runtime, marketplace, tarball |
| Webhooks | `src/webhooks.ts` | 18 outbound events, HMAC, SSRF, retry |
| Retention | `src/retention.ts` | Daily purge (views 90d, metrics 365d, deliveries 30d) |
| Providers | `src/providers/` | Unified optional-provider status |
| Export | `src/export/` | CSV/JSON/vCard |

### File counts at freeze

| Kind | Count |
| --- | --- |
| TypeScript / TSX (excl. dist) | 397 |
| Test files (`*.test.ts(x)`) | 155 (core 92, CLI 28, server 14, web 11, db 10) |
| Lines of TS/TSX | ~86,565 |
| Drizzle tables | 27 (+ SQLite FTS5 virtual table `contacts_fts`) |
| Migrations | 15 per dialect (sqlite + postgres) |
| CLI top-level commands | 27 |
| Web pages | 11 (`/` + 10 app routes) |

---

## Interfaces

### CLI (`apps/cli`) — 27 commands

`init` · `serve` · `status` · `token` · `config` · `import` · `scan` · `enrich` · `search` · `reindex` · `outreach` · `analyze` · `path` · `track` · `edge` · `campaign` · `export` · `card` · `migrate` · `backup` · `restore` · `skills` · `events` · `content` · `team` · `plugin` · `webhook`

Global `--workspace <id>`. Most commands support `--json`.

### HTTP API (`packages/server`)

Public: `GET /api/health`, `GET /api/server-info`. Everything else requires the local operator (loopback in `local` mode, bearer token otherwise, or `open`). Full table: [api-contracts.md](api-contracts.md).

### Web UI (`apps/web`) — 11 pages

Landing · Observatory · Network · Search · Pathfinder · People (+ `[id]` timeline) · Activity · Scan · Import · Settings.

**CLI-only by design:** campaigns, skills, events, content, teams, plugins, webhooks, backup/restore, migrate, edge provenance UI.

---

## External integrations (all optional, BYO-key)

| Kind | Providers | When they run |
| --- | --- | --- |
| AI drafting | OpenAI-compatible, Anthropic | Explicit `outreach` / `--draft` |
| Enrichment | Hunter, People Data Labs, Clearbit | Explicit enrich / scan with keys |
| Embeddings | OpenAI embeddings (JSON vectors, no pgvector) | Explicit `reindex --embeddings` |
| Content metrics | RSS (enabled); Dev.to / Twitter / GitHub **disabled stubs** | Never in background |
| Event discovery | Interface only; default `disabled` | Never in v3.0.2 |

No provider is called during import. Keys live in env, CLI keychain, or AES-256-GCM vault. Reads return `lastFour` only.

---

## Test / build / CI status

### GitHub Actions (authoritative for this freeze)

Last run on this exact commit:

| Field | Value |
| --- | --- |
| Workflow | CI |
| Run | `34751640751` |
| Result | **success** |
| Duration | 9m 36s |
| Trigger | push `master` / `Add files via upload` |
| When | ~8 days before Phase 0 |

CI gate (`.github/workflows/ci.yml`):

1. Lint + typecheck (Node 20 and 22)
2. Unit tests (hermetic Vitest, real scratch SQLite)
3. SQLite integration + marketplace e2e
4. PostgreSQL integration (postgres:16-alpine) + core PG suites + perf pass + migrate twice
5. Build all workspaces + `package:check` + installed-tarball smoke
6. CLI process smoke
7. Server smoke (SQLite **and** PostgreSQL)
8. Web UI standalone smoke
9. Docker image e2e (migrate via shipped CLI, server + web against Postgres, token-mode 401/200)

Release notes for v3.0.0 recorded **1,650 tests passing** across 136 files at that cut (CLI 363, core 998, db 123, server 136, web 30) plus ~60 PostgreSQL tests skipped without `NETPRO_TEST_DATABASE_URL`. The tree has grown since (155 test files).

### Local re-run during Phase 0 (this sandbox)

| Check | Result |
| --- | --- |
| `npm install` (full, including `better-sqlite3` native) | **Failed** — `prebuild-install` + `node-gyp` cannot fetch `https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz` (`ECONNRESET` / TLS). Native addon did not compile. |
| `npm install --ignore-scripts` | **Succeeded** (337 packages) |
| `npm run typecheck` | **Passed** — 9/9 turbo tasks, 1m 23s (Node 22.22.3) |
| `npm run lint` | **Passed** — 9/9 turbo tasks, 1m 10s. Pre-existing warnings only (0 errors): 1 unused var in `packages/core/src/graph/visualization.ts`; 4 unused vars in `apps/web/components/network-graph.tsx`. Not introduced by Phase 0. |
| `npm test` | **Not run** — requires compiled `better-sqlite3` |
| `npm run test:pg` | **Not run** — no `NETPRO_TEST_DATABASE_URL` in this environment |

**Exit-criterion interpretation:** the frozen commit is the same tree CI already proved green (including the Vitest suite). Local typecheck and lint reproduce cleanly. A local `npm test` re-run is blocked only by sandbox network access to node headers, not by product failures. Re-run `npm ci && npm test` on any machine with Node ≥ 20 and network before Phase 1 lands production code.

### Reproducible build

```bash
npm ci
npm run lint
npm run typecheck
npm test                 # hermetic SQLite
npm run test:pg          # needs NETPRO_TEST_DATABASE_URL
npm run build
npm run package:check
npm run smoke            # CLI + tarball + server + web
```

`packageManager` is `npm@11.17.0` (this sandbox had npm 10.9.8; CI uses npm ci with lockfile).

---

## Database access patterns

- All SQL goes through Drizzle on a discriminated union `SqliteConn | PgConn`.
- Query builders are **duplicated per dialect** (TypeScript cannot call methods on the union). Python should hide this behind one repository, not copy the duplication.
- Workspace isolation: almost every table has `workspace_id`; queries use `workspacePredicate` / `resolveScope` (absent scope → bootstrap workspace `default`).
- Soft-delete: `contacts.deleted_at`. Search, graph, analytics always exclude deleted rows.
- IDs: `crypto.randomUUID()` for rows; installation id `ins_…`; access token `np_…`.
- Timestamps: **ISO-8601 text** on both dialects (not native `timestamptz`), except leftover Auth.js tables (`user`, `account`, `session`, `verificationToken`) which still use Auth.js column names / `timestamp_ms`.
- SQLite pragmas on open: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, file mode `0600`.
- Postgres: advisory lock `4027180651197143` serializes migrations; pool defaults max 10 (or 1 if `NETPRO_SERVERLESS=1`).

---

## Jobs & SSE (in-memory today)

Job registry (`packages/server/src/jobs`) and CLI helper (`apps/cli/src/lib/jobs.ts`) share one shape:

- Types: `import | scan | enrich | index | embed | graph | analyze`
- Status: `queued → running → completed | failed | cancelled`
- Progress 0–100; JSON includes both camelCase and snake_case timestamps

Event bus (`packages/server/src/events`): in-process `EventEmitter`, last **200** events, monotonic `seq`. Canonical types listed in [api-contracts.md](api-contracts.md). CLI can forward into the server via `POST /api/events/ingest`.

**Not persisted.** A Python replacement may keep in-memory for local-first, or add a table later — the **JSON/SSE contract** must not change.

---

## Plugin boundary

- Manifest: name, semver, engine range, capability allow-list, exact-host network allow-list, settings.
- Capabilities: `source | enricher | ai-provider | content-provider | event-discovery | command`.
- Install **disabled**. Enable requires `--i-have-reviewed-permissions`.
- In-process ESM loader; crash isolation (failing plugin is disabled, not fatal).
- `PluginApi.fetch` enforces host allow-list; secrets from vault, never logged.
- Marketplace: static `marketplace/index.json` + SHA-256 tarballs; extraction rejects symlinks, absolute paths, `..`.
- **No OS sandbox.** Python must not weaken this; a real sandbox is a later, explicit phase (plan Phase 16).

---

## Security-sensitive code (do not “simplify” during port)

| Area | Location |
| --- | --- |
| Auth modes local/token/open, loopback, proxy-header distrust, SHA-256 token compare | `packages/server/src/auth/index.ts` |
| Access token files 0600, installation identity | `packages/db/src/identity.ts` |
| AES-256-GCM vault, principal-bound key derivation | `packages/core/src/crypto/` |
| CLI keychain | `apps/cli/src/config/keychain.ts` |
| Security headers, CORS origin allow-list, CSP | `packages/server/src/middleware/security.ts` |
| Per-IP rate limit (600/min default) | `packages/server/src/middleware/rate-limit.ts` |
| Webhook HMAC `t=<unix>,v1=<hmac>`, SSRF + redirect re-check | `packages/core/src/webhooks.ts` |
| Viewer HMAC (daily salt), bot list, 90-day purge | `packages/core/src/views/` |
| Plugin tarball extraction | `packages/core/src/plugins/tarball.ts` |
| LinkedIn URL parser (no scraping, reject lookalikes) | `packages/core/src/import/linkedin-url.ts` |

---

## Known gaps (deferred, not bugs)

Documented in README / `docs/releases/v3.0.0.md`. Do **not** “fix” these as part of migration unless a phase explicitly says so:

- Live event-discovery providers (interface only)
- Live Dev.to / Twitter / GitHub content metrics
- Native `pgvector` ANN (embeddings are JSON)
- AI skills extraction as default (opt-in)
- `$EDITOR` draft review
- Plugin OS sandbox
- Curated marketplace
- Background webhook worker + inbound webhooks
- Web pages for CLI-only capabilities
- npm registry publish (name taken)
- Real SMTP (non-goal)
- README product screenshots
- `SECURITY.md`

---

## Migration risks (Phase 0)

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Dual-dialect SQL | FTS5 vs `tsvector`; JSON-as-text; advisory lock | Golden fixtures on both dialects; do not redesign schema in Phases 1–5 |
| Dialect-duplicated Drizzle queries | Easy to port one branch and miss the other | One Python repository; dialect only at the SQL dialect layer |
| In-memory jobs/SSE | UI depends on event names and job JSON aliases | Contract tests against [api-contracts.md](api-contracts.md) |
| Scoring / RRF / path ranking | Hand-computable formulas; UI and CLI must stay identical | Golden tests in Phase 3–5 before switch |
| Workspace scope | Every query is tenant-scoped | Port `resolveScope` first; default workspace `default` |
| Auth.js leftover tables | `user` / `account` / `session` / `verificationToken` still in schema | Keep them; do not drop during early phases |
| Credential handling | Vault, env, keychain, masked reads | Automated “response/logs ≠ raw key” tests (plan Phase 15, start asserting in Phase 1) |
| Git history rewrite | `git log` is one commit | Use this freeze + GitHub PRs for archaeology |
| Local test re-run blocked here | Sandbox cannot compile `better-sqlite3` | Trust CI on `19f888c`; re-run before merging Python runtime code |

---

## Exit criteria (Phase 0)

| Criterion | Status |
| --- | --- |
| Known-good baseline commit frozen | **Yes** — `19f888c` |
| Existing test suite recorded | **Yes** — CI green on freeze commit; local `npm test` blocked by native-addon network |
| Build/typecheck/lint recorded | **Yes** — CI green; local `typecheck` pass; local `lint` pass (5 pre-existing warnings, 0 errors) |
| Representative fixtures captured | **Yes** — `fixtures/` |
| Architecture documented | **Yes** — this file |
| Capability → package map | **Yes** — [capability-matrix.md](capability-matrix.md) |
| API contracts | **Yes** — [api-contracts.md](api-contracts.md) |
| Data model | **Yes** — [data-model.md](data-model.md) |
| Migration rules + risks | **Yes** — [migration-rules.md](migration-rules.md) |

Phase 0 does **not** add a `backend/` tree. That is Phase 1.
