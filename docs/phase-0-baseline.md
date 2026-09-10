# Phase 0 — Freeze the Current System

**Generated:** 2026-09-10T15:45:45Z  
**Branch:** `arena/01a08bfc-netpro` (session branch; plan suggested `refactor/local-first-web`)  
**Baseline commit:** `ae366596f9d2b2846230b5eee05d3cb65cee9440`  
**Node:** v22.22.3 · **npm:** 10.9.8

## Objective

Record a known-good baseline before the local-first architecture migration.
No architectural changes are mixed into this phase — inventory and verification only.

---

## Package structure

```text
NetPro/
├── apps/
│   ├── cli/          @netpro/cli@3.0.0   — Commander CLI (bundled via tsup)
│   └── web/          @netpro/web@3.0.0   — Next.js 16 UI + API routes + Auth.js
├── packages/
│   ├── config/       @netpro/config@3.0.0 — shared ESLint + Tailwind
│   ├── core/         @netpro/core@3.0.0   — domain/business logic
│   └── db/           @netpro/db@3.0.0     — Drizzle schemas, migrations, createDb
├── plugins/
├── marketplace/
├── scripts/
│   └── vercel-build.mjs
├── docs/
├── vercel.json
├── docker-compose.yml
├── Dockerfile
├── turbo.json
└── package.json      netpro@3.0.0 (private monorepo root)
```

### Dependency direction today

```text
@netpro/config
      ↓
@netpro/db  ←  @netpro/core
      ↓              ↓
   apps/cli    apps/web   (web also owns HTTP API + auth)
```

**Problem (why Phase 1 exists):** `apps/web` is both the UI *and* the application
backend (Next.js Route Handlers). Business logic already lives in `@netpro/core`,
but HTTP/auth/jobs/SSE do not yet have a dedicated server package.

---

## Workspace packages

| Package | Version | Role |
|---------|---------|------|
| `netpro` (root) | 3.0.0 | Turborepo workspace orchestrator |
| `@netpro/cli` | 3.0.0 | Terminal interface; `bin: netpro` |
| `@netpro/web` | 3.0.0 | Next.js Observatory UI + API |
| `@netpro/core` | 3.0.0 | Search, graph, CRM, import, enrichment, … |
| `@netpro/db` | 3.0.0 | SQLite + PostgreSQL via Drizzle |
| `@netpro/config` | 3.0.0 | Shared tooling config |

### Core modules (`packages/core/src/`)

`ai`, `analytics`, `campaigns`, `card`, `content`, `crm`, `crypto`, `enrichment`,
`events`, `export`, `graph`, `import`, `plugins`, `retention`, `search`, `skills`,
`views`, `webhooks`, `workspaces`

### CLI commands (`apps/cli/src/commands/`)

`init`, `config`, `import`, `enrich`, `search`, `reindex`, `outreach`, `analyze`,
`path`, `track`, `edge`, `campaign`, `export`, `card`, `migrate`, `skills`,
`events`, `content`, `team`, `plugin`, `webhook`

> Note: `netpro init` is a stub (`not yet implemented`). There is no `netpro serve`.

### Web API surface (Next.js Route Handlers)

These live under `apps/web/app/api/` and are the current HTTP backend:

```text
/api/health
/api/auth/[...nextauth]
/api/activity
/api/analytics
/api/campaigns, /api/campaigns/[id], …/recipients/[recipientId]
/api/card, /api/card/view, /api/card/views, /api/card/pixel.gif
/api/contacts, /api/contacts/[id]
/api/content, /api/content/[id], …/mentions, …/metrics
/api/edges, /api/edges/[id]
/api/enrich
/api/events, /api/events/[id], …/attendees, …/match
/api/export
/api/follow-ups, /api/follow-ups/[id]
/api/graph/overview, /api/graph/paths
/api/import
/api/interactions
/api/invites/[token], /api/invites/accept
/api/outreach
/api/plugins, /api/plugins/install, /api/plugins/marketplace,
  /api/plugins/[name], …/enable, …/disable, …/settings, …/update
/api/search
/api/settings/keys
/api/skills/extract, /api/skills/gap
/api/webhooks, /api/webhooks/[id], …/deliveries, …/rotate, …/test,
  /api/webhooks/deliveries/[deliveryId]/redeliver, /api/webhooks/events
/api/workspaces/invites, /api/workspaces/invites/[id], /api/workspaces/members
```

---

## Vercel inventory

### Dedicated files

| Path | Purpose |
|------|---------|
| `vercel.json` | Framework=nextjs; `buildCommand: npm run vercel-build` |
| `scripts/vercel-build.mjs` | Build-time migrate + web build for Vercel |
| Root `package.json` → `"vercel-build"` | Entry for root-directory Vercel projects |
| `apps/web/package.json` → `"vercel-build"` | Entry when Root Directory = `apps/web` |

### Runtime / config references (non-test)

| Area | Files | Notes |
|------|-------|-------|
| Dialect inference | `packages/db/src/index.ts` | `VERCEL && DATABASE_URL` → postgresql; refuses sqlite on Vercel |
| Pool sizing | `packages/db/src/index.ts` | `VERCEL \|\| AWS_LAMBDA_FUNCTION_NAME` → pool max 1 |
| Host trust | `apps/web/lib/trust-host.ts` | Auth.js trustHost from `AUTH_URL` / `VERCEL` / … |
| Startup migrations | `apps/web/instrumentation.ts` | Comments about Vercel cold starts |
| Next config | `apps/web/next.config.ts` | Standalone output; “Vercel ignores it” |
| Env examples | `.env.example`, `apps/web/.env.example` | Vercel / Docker deployment notes |
| Docs | `docs/deployment.md`, `docs/getting-started.md`, `README.md` | One-click Vercel deploy |
| CI | `.github/workflows/ci.yml` | Mentions Vercel Node version / cold-start races |
| Migrate CLI | `apps/cli/src/commands/migrate.ts` | Serverless concurrent-start commentary |
| Geo headers | `packages/core/src/views/beacon.ts` | Reads `x-vercel-ip-country` (and CF equivalents) |

### Auth / NextAuth inventory

| Symbol | Where |
|--------|-------|
| `next-auth` / `@auth/drizzle-adapter` | `apps/web` dependencies |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | `.env.example`, `docker-compose.yml`, docs |
| `AUTH_URL`, `AUTH_TRUST_HOST` | `apps/web/lib/trust-host.ts`, compose, docs |
| `GITHUB_CLIENT_ID/SECRET`, `NETPRO_OWNER_GITHUB_ID` | Required for web sign-in today |
| `/api/auth/[...nextauth]` | GitHub OAuth handlers |

### Test fixtures using “Vercel” as sample company data

These are **not** deployment dependencies — company/email fixtures only:

- `apps/cli/src/commands/{analyze,campaign,outreach,reindex,search,track}.test.ts`
- `apps/web/app/api/{search,analytics,campaigns,graph}/…`
- Various `packages/core` search/graph/import tests

---

## Baseline verification results

Run on 2026-09-10 against commit `ae366596` after `npm ci --ignore-scripts` and a
local rebuild of `better-sqlite3` (prebuild download blocked by sandbox TLS to
nodejs.org; native addon compiled from `/usr/local` headers successfully).

| Check | Command | Result |
|-------|---------|--------|
| Lint | `npm run lint` | **PASS** (7/7 tasks) |
| Typecheck | `npm run typecheck` | **PASS** (7/7 tasks) |
| Unit/integration tests | `npm run test` | **PASS** |
| | `@netpro/web` | 62 files, 427 tests |
| | `@netpro/core` | 77 files, 925 passed · 6 files / 40 tests skipped (Postgres-only / optional) |
| | `@netpro/db`, `@netpro/cli` | included in turbo graph — pass |
| Build | `npm run build` | **PASS** (cli tsup + web `next build` + core/db typecheck) |
| CLI smoke | `node apps/cli/dist/index.js --help` | **PASS** — commands listed |
| PostgreSQL tests | `npm run test:pg` / live PG job | **NOT RUN** — no Postgres service in this sandbox |
| Web UI interactive | `next dev` / browser | **NOT RUN** — inventory only; build proves compile |

### Known failures / gaps before migration

1. **No Postgres in sandbox** — live PG integration and `test:pg` not executed here.
   CI job `postgres` covers this on GitHub Actions; treat as known-unverified locally.
2. **`netpro init` is unimplemented** — stub only.
3. **No `netpro serve`** — local server does not exist yet (Phase 2).
4. **Web backend is Next.js** — all `/api/*` routes require the Next runtime;
   there is no standalone HTTP server package (Phase 1 deliverable).
5. **GitHub OAuth required for private web routes** — local use still needs
   `GITHUB_*` + `NEXTAUTH_*` + owner id (Phase 5 will change this).
6. **SQLite default path is `./netpro.db`** — not yet `~/.netpro/netpro.db` (Phase 3).
7. **Vercel is first-class** — `vercel.json`, `vercel-build`, dialect/pool
   special-cases remain (Phases 4 / 20).
8. **Turbo warnings** — `@netpro/core#build` and `@netpro/db#build` emit
   “no output files” because `build` is `tsc --noEmit` (pre-existing; harmless).

### Install note (environment-specific)

```text
npm ci  # failed: better-sqlite3 prebuild + node-gyp header fetch (TLS to nodejs.org)
npm ci --ignore-scripts
cd node_modules/better-sqlite3 && npm_config_nodedir=/usr/local npm run build-release
```

Not a project defect — sandbox network restriction. Documented so baseline
reproducers know how this environment was prepared.

---

## Exit criteria checklist

| Criterion | Status |
|-----------|--------|
| Existing tests pass or known failures documented | ✅ Pass + gaps above |
| All Vercel dependencies inventoried | ✅ This document |
| No architectural changes mixed into baseline | ✅ Inventory-only |

---

## Next phase

**Phase 1 — Separate Server From Web UI** creates `packages/server/` as a
standalone HTTP package that imports `@netpro/core` / `@netpro/db`, does not
depend on Vercel APIs, and does not require `apps/web`.

---

## Phase 1 completion note (same branch)

Delivered on this branch after the baseline freeze:

| Exit criterion | Status |
|----------------|--------|
| `packages/server/` builds independently | ✅ `npm run build -w @netpro/server` |
| Server imports `packages/core` | ✅ health route uses `searchIndexStatus` |
| Server does not depend on Vercel APIs | ✅ deps: `@netpro/core`, `@netpro/db`, `drizzle-orm` only |
| Server does not require the Web UI | ✅ no `@netpro/web` / `next` dependency; smoke-tested alone |

Structure:

```text
packages/server/
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config.ts
│   ├── server.ts
│   ├── routes/
│   ├── middleware/
│   ├── jobs/
│   ├── events/
│   └── auth/
└── package.json
```

Default bind remains `127.0.0.1:3777`. Full `netpro serve` CLI wiring is Phase 2.
