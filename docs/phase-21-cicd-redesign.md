# Phase 21 — CI/CD redesign

**Generated:** 2026-09-11
**Follows:** [Phase 20](phase-20-vercel-deletion.md)

## Objective

CI must validate the actual NetPro architecture — a local-first CLI, a
long-lived HTTP server, and a Web UI client — in the order the plan prescribes:

```text
Install → Lint → Typecheck → Unit tests → SQLite integration tests
        → PostgreSQL integration tests → Build
        → CLI smoke tests → Server smoke tests → Web UI smoke tests
```

The old workflow bundled lint/typecheck/test/build into one job and only
exercised the shipped artifacts inside Docker. The redesigned pipeline keeps
every stage as its own `needs:`-chained job (a later stage never hides an
earlier failure) and adds explicit, process-level smoke tests over the built
artifacts.

---

## Pipeline (`.github/workflows/ci.yml`)

| # | Job | What it proves |
|---|-----|----------------|
| 1 | **lint-typecheck** (Node 20 **and** 22 matrix) | `npm ci` (Install), `npm run lint`, `npm run typecheck` |
| 2 | **unit** | `npm run test` — the hermetic vitest suite against real scratch SQLite files; PostgreSQL suites self-skip without a server |
| 3 | **sqlite-integration** | the db + cli package suites against real on-disk SQLite, plus the reference-plugin marketplace end-to-end install from the shipped index (`file://`, no network) |
| 4 | **postgres-integration** | real PostgreSQL 16 service: dialect-specific db/core vitest suites, the perf pass, and the migration CLI including idempotent re-apply |
| 5 | **build** | `npm run build` for every workspace and the package-content gate (`npm run package:check`) |
| 6 | **cli-smoke** | `scripts/smoke/cli.sh` — the shipped CLI as processes (below) |
| 7 | **server-smoke** (SQLite **and** PostgreSQL matrix) | `scripts/smoke/local-stack.sh` per dialect — the long-lived server as a process (below) |
| 8 | **web-ui-smoke** | `scripts/smoke/web-ui.sh` — the production standalone Next.js output really serves |
| 9 | **docker** | the published self-hosting image on PostgreSQL: shipped-CLI migrations, health, Web UI loading, every auth boundary, beacons, GitHub mode, and clean logs |

Each GitHub Actions job is a fresh VM, so the smoke jobs provision with
`npm ci` and rebuild exactly the artifacts they exercise; the `needs:` chain
is what enforces the global ordering (the full monorepo Build gates every
smoke). The server smoke is a two-leg matrix so `/api/health`, the API
surface, and SSE are proven on **both** database startups.

## Smoke scripts (`scripts/smoke/`)

All three scripts are hermetic: `NETPRO_HOME` points at a scratch directory,
servers bind `127.0.0.1` on ephemeral ports, and an EXIT/INT/TERM trap tears
every spawned process down. Shared helpers live in `common.sh`.

### `cli.sh` — CLI smoke (SQLite)

1. bundled `netpro --help` exposes `init`, `serve`, and the command tree;
2. **`netpro init`** writes `config.toml`, the installation identity
   (`ins_…`), a `0600` token under `keys/`, the SQLite database, and applies
   15/15 migrations;
3. **`netpro init` again** keeps the existing config byte-for-byte;
4. **`netpro migrate --status`** reports `Applied: 15/15, Pending: 0`, and
   **`netpro migrate`** is a no-op ("already up to date");
5. **`netpro serve --port <ephemeral>`** starts from the CLI;
6. **`netpro status`** observes the live server (`running`, `healthy`,
   `sqlite`);
7. SIGTERM shuts the CLI-managed server down gracefully.

### `local-stack.sh` — server smoke (dialect matrix)

Runs against a scratch install and an ephemeral port:

1. **`netpro init`** (15/15 migrations; dialect-labelled output) and
   idempotent re-run;
2. **`netpro serve`** binds `127.0.0.1:0`, prints the Phase 2 banner and the
   local auth policy, and answers SIGTERM;
3. **`/api/health`** is healthy and names the dialect — SQLite **and**
   PostgreSQL startup — with verbose health reporting migrations + search;
4. **API calls** answer: `/api/contacts`, `/api/jobs`, `/api/settings`,
   `/api/providers`, `/api/search`, `/api/graph`; `POST /api/scan` creates an
   observable job fetchable through `/api/jobs/:id`;
5. **SSE**: a live `text/event-stream` connection to `/api/events/stream`
   receives `search.started` / `search.completed` (and the `retry:` interval)
   when a search runs;
6. the built-in console page `/` loads;
7. the **auth boundary** holds: a proxied request (`X-Forwarded-For`) gets
   401, the same request with the real bearer token gets 200;
8. **`netpro status`** sees the running server as healthy;
9. the standalone `netpro-server` bin (what Compose runs) starts and serves.

### `web-ui.sh` — Web UI smoke

Stages `apps/web/.next/standalone` exactly like the Dockerfile runner
(`server.js` + traced `node_modules` + static + `public/`), starts it on
loopback with a scratch SQLite install and `NETPRO_TRUST_LOCAL_UI=1`, and
asserts:

- the landing page returns 200 with the local-first copy
  ("Private. Local. Searchable.") and production security headers (CSP,
  nosniff);
- `/login` renders;
- the UI's `/api/health` is healthy on SQLite (the data path works);
- the private `/observatory` renders for the trusted loopback operator;
- a hashed `/_next/static/...js` asset referenced by the page loads;
- SIGTERM stops the process cleanly.

## Running the smokes locally

```bash
npm run build                       # all shipped artifacts
npm run smoke                       # cli + server(sqlite) + web

# individual stages
npm run smoke:cli
npm run smoke:server
npm run smoke:web

# server smoke against a real PostgreSQL server
SMOKE_DIALECT=postgresql \
  DATABASE_URL='postgresql://netpro:netpro@127.0.0.1:5432/netpro?sslmode=disable' \
  npm run smoke:server
```

## Docker e2e additions

The Docker job keeps the non-loopback-Host boundary checks and gains the
Phase 21 Web UI assertions against the real image: landing page 200 with
NetPro markup and the local-first on-ramp, `/login` 200, and the hashed
static asset referenced by the page loads. The GitHub-mode re-check also
confirms `/login` still serves while private APIs remain 401.

One boundary is deliberately *not* asserted against the container: with
`NETPRO_TRUST_LOCAL_UI=1` (required because the Docker bridge masks the
socket peer; the compose port is published on `127.0.0.1` only), the Web UI
trusts a loopback Host without inspecting `X-Forwarded-For` — see
`isTrustedLocalRequest` in `apps/web/lib/auth-mode.ts`. The proxy-header
boundary is a property of the standalone `@netpro/server` layer instead,
and the server-smoke matrix proves it on both dialects (proxied request
401, same request with the bearer token 200).

## What the redesign fixed to make the gate real

The lint command could not pass before this phase (42 server + 7 web errors),
which made the lint stage a known-red gate:

- removed seven `// @ts-nocheck` markers from the server and Web UI (enrich
  route, the end-to-end API smoke test, four Observatory/Network/People/
  Activity surfaces and the Observatory component) and fixed the real type
  errors they hid — dialect-table narrowing in the enrich route, named
  response types replacing narrowed `typeof` queries in the Network page, and
  undefined-value guards;
- removed `any` from the API smoke by typing the scratch connection and JSON
  envelopes (a single scoped ESLint relaxation stays, with `tsc` fully
  active);
- replaced unnecessary quote escapes and filled two empty catches;
- connected or removed genuinely dead code (settings serializer, buffer
  normalizer, an unknown React rule-disable comment).

## Exit criteria

| Criterion | Status |
|-----------|--------|
| Lint validates the whole repo (both supported Node lines) | ✅ job 1, zero errors |
| Typecheck is a separate gate | ✅ job 1 |
| Unit tests run on every change | ✅ job 2 |
| SQLite integration explicit (real on-disk suites + marketplace) | ✅ job 3 |
| PostgreSQL integration explicit (suites + perf + migration idempotency) | ✅ job 4 |
| Full build is a gate | ✅ job 5 |
| CLI smoke: `netpro init`, `netpro migrate`, `netpro serve`, `netpro status` | ✅ job 6 / `cli.sh` |
| Server smoke: `/api/health`, SQLite + PostgreSQL startup, API calls, SSE, standalone bin | ✅ job 7 matrix / `local-stack.sh` |
| Web UI loading smoke (standalone production build) | ✅ job 8 and Docker job 9 |
| `npm run lint/typecheck/test/build` remain the standard commands | ✅ unchanged at the root |
