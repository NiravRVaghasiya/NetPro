# NetPro — Python-First Migration: Baseline & Analysis

> This document is the **Phase 0 deliverable** defined in
> [`NetPro_Python_First_Implementation_Plan.md`](../../NetPro_Python_First_Implementation_Plan.md).
> It records the verified baseline of the current TypeScript codebase and maps every
> migration phase to the concrete code it will touch, so the migration starts from
> facts rather than assumptions.
>
> All numbers below were measured on the working tree at commit
> `19f888c` ("Add files via upload"), branch `master`, 2026-09-13.

---

## 1. Verified baseline

### 1.1 Test suite (the migration safety net)

Executed: `npx vitest run` at the repo root (Node v22.22.3, all workspace projects).

| Metric | Result |
|---|---|
| Test files | **155** (147 passed, 8 skipped) |
| Tests | **1,841** (1,779 passed, 62 skipped, **0 failed**) |
| Duration | ~74 s |
| Skipped suites | PostgreSQL integration + perf-budget tests (env-gated) |

Exit status 0 — **the baseline is green and reproducible.** The 62 skips are gated
PostgreSQL/perf tests, not failures. Any Python migration work must keep this suite
green until Phase 17 (TypeScript retirement).

Environment note for reproducing the baseline in CI-like sandboxes:
`better-sqlite3` must compile from source when
`objects.githubusercontent.com` (prebuilt binaries) is unreachable — use
`npm_config_nodedir=<node prefix>` if `/usr/local/include/node` headers are present.

### 1.2 Repository shape

| Package | Path | Role | Src LOC (non-test) |
|---|---|---|---|
| `@netpro/core` | `packages/core` | All domain logic, graph, search, AI, integrations | **29,695** |
| `@netpro/db` | `packages/db` | Drizzle schema (dual dialect), migrations, backup, identity | 3,150 |
| `@netpro/server` | `packages/server` | Hand-rolled `node:http` API server, jobs, SSE, auth, middleware | 5,179 |
| `netpro` (CLI) | `apps/cli` | Commander CLI, 27 command groups | 8,420 |
| `@netpro/web` | `apps/web` | Next.js UI (11 pages), SSE hooks | 7,060 |
| — | — | **Total TS/TSX (non-test)** | **~53,500** |
| — | — | Test code | 32,654 (155 files) |

Toolchain: npm workspaces + Turborepo, Node ≥ 20, TypeScript 5.9, Vitest 4, ESLint 10,
Prettier, Drizzle ORM 0.45, better-sqlite3 12 / pg 8, Next.js (standalone output),
Docker + docker-compose, GitHub Actions (`ci.yml`, `release.yml`).

History note: the repo is a **single commit** ("Add files via upload") — there is no
git archaeology to lean on. Code comments reference internal plans ("v2.0 plan
Phase N", "DB & Pipeline Deep Dive §2.6") that are **not in the repository**; the
code and its tests are therefore the only authoritative behavior spec. This makes
the plan's contract-first/golden-test approach mandatory, not optional.

### 1.3 Data model (29 tables, `packages/db/src/schema.sqlite.ts` / `schema.pg.ts`)

- **CRM core:** `contacts`, `interactions`, `edges` (relationships), `follow_ups`, `activity_log`
- **Workspaces (v3.0):** `workspaces`, `workspace_members`, `workspace_invites` — every data
  table carries `workspace_id` (default `'default'`), enforced by `scope-guard.ts`
- **Discovery:** `events`, `event_attendees`, `content_items`, `content_metrics`, `content_mentions`,
  `profile_views`, `profile_cards`, `search_index`, `enrichments`
- **Outreach:** `campaigns`, `campaign_recipients`
- **Auth/identity:** `user`, `session`, `account`, `verification_tokens` (better-auth-style tables;
  local installs use installation identity instead — `~/.netpro`, `ins_…` ids, 0600 access token)
- **Platform:** `plugins`, `webhooks`, `webhook_deliveries`, `key_vault` (encrypted provider keys)

Conventions that Python **must reproduce byte-for-byte** to open existing databases:

- Primary keys are **text UUID v4 strings** (`crypto.randomUUID()`), not integers.
- Timestamps are **ISO-8601 TEXT** columns (`createdAt`, `updatedAt`, `deletedAt`), not native DB types.
- Tags/skills/custom fields are **JSON-in-text** columns.
- `contacts.relationship_score` stores the 0–100 score **normalized to 0–1** (two decimals).
- Migrations are **hand-written SQL** (`.sql` files) per dialect:
  `packages/db/migrations/sqlite/0000…0014` and `.../postgres/…` (15 each), with
  preservation tests (`migration-preservation.test.ts`, `postgres.preservation.test.ts`).

### 1.4 Product posture (README, verified in code)

Local-first personal CRM + network-graph analyzer. SQLite in `~/.netpro` by default,
PostgreSQL optional. Server binds `127.0.0.1:3777` by default. No telemetry.
**Draft-first; human sends** (no SMTP anywhere). All AI/enrichment/embedding providers are
BYO-key and optional — with zero keys configured, NetPro still imports, indexes, searches,
analyzes, scores and reminds. MIT licensed.

---

## 2. Capability matrix — plan phase → current code

| # | Capability | Current implementation | Key files (`packages/core/src/…` unless noted) | Existing tests usable as golden fixtures |
|---|---|---|---|---|
| P2 | Persistence | Drizzle dual-dialect schema + hand-written SQL migrations | `packages/db/src/schema.{sqlite,pg}.ts`, `migrate.ts`, `backup.ts` | `migrations.test.ts`, `backup.test.ts`, `postgres.integration.test.ts` |
| P3 | Domain model | CRM module: add-person, contacts, interactions, follow-ups, timeline, activity | `crm/*` | `add-person.test.ts`, `contacts.test.ts`, `interactions.test.ts`, `follow-ups*.test.ts` |
| P3 | **Relationship scoring** | Documented 4-factor formula (see §3.1) | `crm/scoring.ts` (97 LOC, pure) | `scoring.test.ts` — direct golden fixture |
| P4 | Graph construction / analysis | Pure TS: components, degree, Brandes betweenness (budgeted), Louvain (deterministic), paths | `graph/{analysis,centrality,louvain,paths,network,edges,position,visualization}.ts` | `graph/*.test.ts` — hand-computed determinism tests |
| P4 | Pathfinder | BFS chains → ranked warm-intro paths (see §3.3) | `graph/pathfinder.ts`, `paths.ts` | `pathfinder.test.ts`, `paths.test.ts` |
| P5 | Search | 3-arm hybrid: portable substring + dialect FTS (FTS5/tsvector) + semantic; RRF fusion (k=60) | `search/{hybrid,rrf,arms,conditions,fetch,indexer,embeddings,explain}.ts` | `hybrid.test.ts`, `rrf.test.ts` (hand-computed), `query.test.ts`, `perf.test.ts` |
| P6 | LinkedIn URL UX | Syntactic-only validation/normalization; **no scraping by design** | `import/linkedin-url.ts` | `linkedin-url.test.ts` |
| P6 | API-key flow | Encrypted key vault; never returned raw | `crypto/{vault,provider-keys,key-vault}.ts` | `crypto/*.test.ts`, `server/src/credentials.test.ts` |
| P7 | Imports | LinkedIn CSV, preview/validate pipeline, dedupe/merge, backup/restore | `import/{linkedin-csv,pipeline,preview,normalize}.ts` | `import/*.test.ts` |
| P7 | Enrichment | Hunter, PDL, Clearbit adapters | `enrichment/providers/*.ts` | per-provider tests |
| P7 | Events/content | Event match/parse/repo, RSS/content tracker | `events/*`, `content/*` | `events/*.test.ts`, `content/*` |
| P8 | AI drafting | OpenAI + Anthropic adapters, prompt construction, compose limits | `ai/*` | `ai/*` tests |
| P8 | Skills | Bounded taxonomy, deterministic extract, gap analysis | `skills/*` | `skills/*.test.ts` |
| P9 | CRM ops | Timeline, dormancy, assignment, recurrence | `crm/{timeline,follow-ups,activity}.ts`, `analytics` | `crm/*.test.ts`, `analytics` tests |
| P10 | Campaigns | Lifecycle, recipient snapshots, merge vars, per-day limits; draft-only | `campaigns/*` | `campaigns/*.test.ts` |
| P11 | Jobs/SSE | **In-memory** job registry (queued/running/completed/failed) + SSE event bus | `packages/server/src/{jobs,events}/index.ts` | `jobs.test.ts`, `events.test.ts` |
| P12 | HTTP API | **Hand-rolled `node:http`** router (no framework); ~35 `/api/*` route groups | `packages/server/src/{app,routes/*,middleware/*,auth}.ts` | `api.test.ts`, `security.integration.test.ts`, `contacts-post.test.ts` |
| P13 | CLI | Commander, 27 command groups (init, serve, import, search, analyze, path, track, edge, campaign, skills, events, content, team, plugin, webhook, backup, …) | `apps/cli/src/commands/*` | `apps/cli/src/commands/*.test.ts` |
| P14 | Web UI | Next.js 11 pages (people, search, network, pathfinder, observatory, import, scan, activity, settings) + SSE hook | `apps/web/app/(app)/*`, `hooks/use-netpro-events.ts` | per-page `.test.tsx` |
| P15 | Security | Auth modes open/token, loopback default, origin allow-list, HSTS, rate limit, SSRF-safe fetch, secret redaction, retention | `server/src/{auth,middleware}` , `core/src/{retention,views/*}.ts` | `security.integration.test.ts`, `webhooks.security.test.ts`, `views/*.test.ts` |
| P16 | Plugins | Manifest + capability/network allow-lists, sandbox policy, checksummed marketplace tarballs, disabled by default | `plugins/*`, `marketplace/` | `plugins/*.test.ts` |
| P17 | TS retirement | — | gated on everything above | full suite stays green |

---

## 3. Behavior contracts the plan explicitly freezes

These are the exact, hand-verifiable rules the plan's §2.1 ("preserve behavior")
protects. Each already has deterministic tests — the Python golden-test harness can
lift inputs/expected values straight from them.

### 3.1 Relationship score (`crm/scoring.ts`)

```
score = 0.40·recency + 0.25·frequency + 0.20·depth + 0.15·richness   (0–100)

recency   = max(0, 100 − 0.5 × days_since_last_interaction)
frequency = min(100, 15 × interactions_in_last_90_days)
depth     = 100 × min(inbound, outbound) / max(inbound, outbound, 1)
richness  = min(100, 25 × distinct_interaction_types)      (saturates at 4 types)

column value = round(score) / 100        ← 0–1 scale stored in DB
```

Pure function of `(interactions, now)`; "last interaction" derived by max timestamp,
never row order. Zero interactions ⇒ 0.

### 3.2 Hybrid search fusion (`search/rrf.ts`, `hybrid.ts`)

```
score(d) = Σ_arm  weight_arm / (60 + rank_arm(d))       rank is 1-based

arm weights:  keyword=1, semantic=0.9, portable=0.5
```

- The **portable substring arm always participates** — hybrid never returns less than
  v1 substring search even with a stale/empty FTS index.
- Filters are constraints applied inside every arm; free text is what gets ranked.
- Deterministic tie-breaks: score desc → more contributing arms → best single rank →
  id ascending. **Determinism is load-bearing** (coherent pagination).
- Graceful degradation: no embedder → two arms; no FTS index → substring only.
- Explainability: every result reports *why* it matched.

### 3.3 Pathfinder (`graph/pathfinder.ts`)

```
path score = 0.6 × weakestTie + 0.4 × avgHopStrength

weakestTie     = min relationshipScore over origin+intermediaries (null ⇒ 0;
                 direct connection has no weak link ⇒ tie term = 1)
avgHopStrength = mean over hops of (min strength × min confidence)
```

Equal scores order by lexicographically smallest id chain. Default origin (when
`--from` omitted) = strongest tie (score, then most recent interaction, then id).
BFS shortest chains first; **no auto-pick** — the human chooses. Draft-only by contract.

### 3.4 Graph semantics (`graph/*`)

- Centrality treats the graph as **undirected simple** (direction belongs to pathfinder only).
- Betweenness is **Brandes, unweighted**, with an honest skip above
  `limits.betweennessMaxNodes` (O(V·E) budget) — reported as `null` + reason.
- Louvain is **pure TS, deterministic**: nodes swept in sorted-id order, equal gains →
  lowest community index. Classical modularity conventions (self-loops count once in
  `m`, twice in `k_i`).
- Edges carry provenance and an **inferred/pending → confirmed** lifecycle.

### 3.5 LinkedIn URL (`import/linkedin-url.ts`)

- Canonical form `https://www.linkedin.com/in/<username>`; http→https, subdomains →
  `www`, trailing slash stripped, query/fragment stripped, profile sub-pages collapse
  to the base profile.
- `usernameKey` = lowercased slug = the stable dedupe key. Slug: 1–128 chars
  `[A-Za-z0-9._-]`, no `..`, no control chars; URL cap 2048 chars.
- Errors are typed (`empty` / `invalid_url` / `not_linkedin` / `unsupported_route`) —
  the distinction drives UI copy.
- **Deliberately syntactic only — never touches the network.** The codebase contains
  no LinkedIn scraping, and the plan §Phase 6 explicitly forbids inventing any.

### 3.6 Jobs & SSE (`server/src/{jobs,events}`)

- Job statuses: `queued → running → completed | failed`; registry is **in-memory today**
  (the plan's DB-backed job state is an intentional, documented change).
- SSE event `type` maps to the browser `event:` field — consumers:
  `contact.imported`, `contact.updated`, `graph.updated`, `import.started/progress/completed`,
  `enrichment.started/completed`, `job.queued/running/progress/completed/failed/cancelled`.
  The web UI hook (`use-netpro-events.ts`) must not notice the engine change.

### 3.7 Credentials (`crypto/*`)

Provider keys live in an encrypted `key_vault`, are never logged, never returned raw
by the API, never stored in browser localStorage, never placed in URLs. The plan's
Phase 15 adds automated assertions for each of these invariants.

---

## 4. The plan, distilled

**Strategy:** incremental strangler migration — never big-bang. Target is a
**Python modular monolith** (FastAPI + Pydantic v2 + SQLAlchemy 2 + Alembic + Typer +
NetworkX + httpx + uv + Ruff + pytest), with the Next.js UI kept in TypeScript.
Python becomes *authoritative* for domain, intelligence, integrations, API, CLI, jobs;
TypeScript remains the browser UI.

**Non-negotiables:** preserve behavior (§2.1); one business rule, one implementation
(§2.2); contract-first — capture behavior in tests before porting (§2.3); no premature
microservices/Redis/K8s (§2.4); existing SQLite/PostgreSQL databases keep working (§25);
`netpro doctor` for post-migration verification.

**Priority order (§29):** graph → search → LinkedIn/API-key UX are the three
high-priority phases (P4–P6) because Python's ecosystem advantage is strongest there.
Explicitly **not** first: frontend, plugins, campaigns, auth rewrite, microservices.

**Definition of done (§31):** one authoritative implementation per rule; the user
cannot tell which language the backend is in; `uv sync && uv run pytest &&
uv run netpro serve` works; security posture preserved-or-better; existing data opens.

**First milestone (§33) — "NetPro Python Core":** Python project + DB connectivity +
Person/Relationship domains + scoring + graph + Pathfinder + search + tests + FastAPI
and CLI skeletons. **First vertical slice (§32):** Web UI → FastAPI → application →
SQLAlchemy → existing DB (Person + Relationship), then expand.

---

## 5. Risks, gaps, and observations

1. **The HTTP server is hand-rolled `node:http`, not Express/Fastify.** There is no
   framework middleware model to map 1:1 onto FastAPI. The API *contract* lives in
   `routes/*.ts` + `api.test.ts` / `security.integration.test.ts` / `contacts-post.test.ts`.
   Those tests — not the framework — are the compatibility spec for the FastAPI port.
   Same for the CLI: Commander → Typer is a surface swap; behavior lives in
   `apps/cli/src/commands/*.test.ts`.

2. **Drizzle → SQLAlchemy with hand-written SQL migrations.** The plan's "port
   migration logic to Alembic" must not renumber or reorder the existing `.sql`
   migrations — `migration-preservation.test.ts` treats them as load-bearing history
   for existing installs. Alembic should start by *adopting* the current schema state
   (baseline revision = schema at migration 0014), not re-deriving it.

3. **Determinism is a product feature, not a nicety.** RRF tie-breaks, Louvain sweep
   order, pathfinder ordering, and "byte-identical reruns" are all asserted by tests
   and relied on for pagination. Python ports must reproduce exact ordering rules —
   including UUID string comparisons and sorted-id iteration — or the golden tests
   will (correctly) fail.

4. **NetworkX is not a drop-in for the pure-TS algorithms.** `networkx.louvain_communities`
   is randomized unless seeded and does not promise NetPro's "sorted-id sweep, lowest
   index on equal gain" partition. Either port the TS Louvain directly (it is compact
   and well-tested) or prove equivalence on the same fixtures. Brandes and degree
   centrality map cleanly; the betweenness node-budget skip must be re-implemented.

5. **In-memory jobs → DB-backed jobs is a behavior change** (crash-restart semantics
   improve; memory footprint changes; SSE replay story may change). Plan §Phase 11
   already frames it as intentional — document it in the migration rules file.

6. **Single-commit history = no archaeology.** Comments cite external plan docs
   ("DB & Pipeline Deep Dive", "v2.0 plan") that are not in the repo. When porting,
   the *code + tests* are the spec — never a comment's memory of a missing document.

7. **Two auth worlds coexist.** better-auth-style tables (`user`/`session`/`account`)
   exist in schema, but local installs use installation identity (`ins_…` + loopback
   trust + 0600 token file). The Python port must implement the *local* model first
   and treat the table-based model as forward-compatible schema, matching current code.

8. **Test-suite speed is an asset.** 74 s for 1,841 tests. The Python CI plan
   (§27) should preserve that property — keep unit tests hermetic, gate Postgres and
   perf tests behind markers like the current suite does.

9. **The plan and the codebase agree on the hard lines.** No LinkedIn scraping
   (both say it), draft-first outreach (both say it), BYO-key everything (both say
   it), local-first (both say it). The migration is unusually well-aligned with the
   existing architecture because both were written against the same product invariants.

---

## 6. Recommended immediate next steps (plan §32, made concrete)

1. `backend/` Python 3.12+ project via `uv`, Ruff + pytest + type-checking configured.
2. SQLAlchemy 2 models for `contacts` + `interactions` + `edges` reading the **existing**
   SQLite schema (text UUIDs, ISO-text timestamps, JSON-text columns) — verified by
   opening a DB created by the TS CLI (`netpro init`).
3. Port `crm/scoring.ts` as the first domain service; lift `scoring.test.ts` cases
   verbatim as golden tests.
4. Port `graph/{analysis,centrality,paths}` construction + Pathfinder; reuse the
   deterministic graph fixtures from `graph/*.test.ts`.
5. Stand up the FastAPI skeleton with `/api/health` and one route serving Person reads
   against the same DB, behind the same auth policy.
6. Add Python CI alongside the existing workflow, without touching the TS gates.

---

*Authored as Phase 0 of the migration defined in `NetPro_Python_First_Implementation_Plan.md`.*
