# `@netpro/server`

Standalone HTTP server for local-first NetPro.

This package is the application backend. The Web UI (`apps/web`) is a client.

## Scope

- Builds independently via `tsup`
- Imports `@netpro/core` and `@netpro/db` for domain work and persistence
- Does **not** depend on hosted-platform APIs, `next`, or `apps/web`
- Default bind: `127.0.0.1:3777` (remote bind is opt-in and warns)
- Ships `GET /api/health`, the built-in console page at `/`, and scaffold
  modules for auth, jobs, and SSE events
- **Phase 2:** `runServe()` powers `netpro serve` — banner, loopback-only
  defaults, actionable listen errors, graceful SIGINT/SIGTERM shutdown
- **Phase 3:** server settings and the database resolve through
  `~/.netpro/config.toml` + `NETPRO_*` env (see `docs/local-first.md`)
- **Phase 6:** stable Web API contract — every Web UI data requirement has
  a server API; routes orchestrate `@netpro/core` (no business logic duplicated
  in the web layer). See [API](#api) below.
- **Phase 7:** observable job system — `queued → running → completed|failed|cancelled`
  with `0–100` progress, shared by CLI (`apps/cli/src/lib/jobs.ts`) and server
  (`packages/server/src/jobs`). One operation → one core implementation → one
  job → one event stream → multiple interfaces.
- **Phase 8:** `GET /api/events` SSE transport (see [Events](#events)).

## API

All routes are authenticated per the Phase-5 policy (loopback trusted in
`local` mode, bearer token `Authorization: Bearer <token>` / `X-NetPro-Token` /
`?token=` otherwise, `open` mode trusts the deployer). `GET /api/health`
and `GET /api/server-info` are public.

| Method | Path | Core | Notes |
|--------|------|------|-------|
| GET | `/api/health` | `searchIndexStatus` + migrations | `?verbose=1` adds migrations + search mode for trusted callers |
| GET | `/api/server-info` | — | service identity |
| GET | `/api/identity` | `readInstallationIdentity` | installation id + auth mode, never the token |
| GET | `/api/contacts` | `listCrmContacts` | `?limit=&offset=&sort=recent\|score\|name\|follow-up` |
| GET | `/api/contacts/:id` | `getContactTimeline` | profile + stats + interactions + follow-ups; 404 when deleted |
| POST | `/api/contacts` | `addPersonFromLinkedIn` | `{ linkedinUrl, fullName? }` → 201 created / 200 exists (never a silent duplicate); `{ linkedinUrl, dryRun: true }` validates + duplicate-checks without writing |
| GET | `/api/credentials` | `listVaultKeys` + catalog | every provider's masked status (`lastFour`, never the key) + vault availability |
| PUT | `/api/credentials/:provider` | `testProviderKey` + `saveVaultKey` | `{ apiKey }` → remote-validates where safe, then saves encrypted; 422/502 leave the stored key untouched; 503 without `ENCRYPTION_MASTER_KEY` |
| POST | `/api/credentials/:provider/test` | `resolveVaultKey` + `testProviderKey` | tests the stored key; 200 with `{ status, message }`, never the key |
| DELETE | `/api/credentials/:provider` | `removeVaultKey` | removes the vault row; reports env configuration honestly |
| GET | `/api/search` | `searchContacts` | `?q=&company=&role=&location=&industry=&seniority=&hasEmail=&minScore=&activeWithin=&skills=&sort=&limit=&offset=&mode=portable\|keyword\|hybrid` |
| GET | `/api/graph` <br> `GET /api/graph/overview` <br> `GET /api/graph/network` | `getNetworkGraph` | communities, centrality, components, warm-intro candidates; `?limit=&depth=&relation=&status=&minConfidence=` |
| GET | `/api/graph/path` <br> `GET /api/graph/paths` | `planIntroPaths` | `?target=&from=&k=&depth=`; `target` required |
| GET | `/api/analytics` <br> `GET /api/analytics/network` | `getNetworkOverview` | metrics, score, growth, clusters, dormant, graph, views, content; `?days=&activeDays=&months=&limit=&graph=&views=&content=` |
| POST | `/api/import` | `runImport` | `multipart/form-data` `file` **or** `application/json` `{csv}` **or** `text/csv` body; creates a `type: import` job |
| GET | `/api/import/:id` | job registry | import job by id (alias for `GET /api/jobs/:id`) |
| POST | `/api/scan` | — (emulated scan) | creates a `type: scan` job with `15 → 40 → 70 → 90 → 100` progress |
| GET | `/api/jobs` | job registry | `?type=&status=&limit=&offset=`; newest first |
| GET | `/api/jobs/:id` | job registry | |
| POST | `/api/jobs` | job registry | `{type, metadata}` → `201` queued job |
| POST | `/api/jobs/:id/cancel` | job registry | cancels `queued`/`running` |
| GET | `/api/events` | `EventBus` | **SSE** when `Accept: text/event-stream`, else calendar events JSON |
| GET | `/api/events/stream` | `EventBus` | SSE alias |
| GET | `/api/events/:id` | `getEvent` | calendar event detail |
| GET | `/api/settings` | `readLocalConfig` + `describeConn` | server, database, auth, installation; file-managed note on PUT |
| PUT | `/api/settings` | — | validates keys, returns file-managed guidance |
| GET | `/` | — | local console HTML (loopback only) |

## Jobs

```ts
type Job = {
  id: string;
  type: 'import'|'scan'|'enrich'|'index'|'embed'|'graph'|'analyze';
  status: 'queued'|'running'|'completed'|'failed'|'cancelled';
  progress: number;            // 0–100
  startedAt: string | null;    // + started_at alias
  completedAt: string | null;  // + completed_at alias
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;           // + created_at alias
  updatedAt: string;           // + updated_at alias
};
```

Progress ladder from the plan (§Phase 7):

```text
Scan 0% queued → 15% discovering → 40% processing → 70% enriching → 90% indexing → 100% completed
```

The registry is in-memory today (persisted in a future phase) but the shape
is the contract: `apps/cli/src/lib/jobs.ts` re-exports the same types and
`createJobRegistry()` so a CLI `netpro import` and a Web UI `POST /api/import`
produce byte-identical job records.

## Events

`GET /api/events` with `Accept: text/event-stream` opens an SSE stream:

```
retry: 3000
: connected

event: job.queued
data: {"type":"job.queued","jobId":"abc","progress":0,"timestamp":"..."}
```

Every `Job` transition publishes `job.*`; domain operations publish
`scan.*`, `import.*`, `contact.imported`, etc. The CLI's `runWithJob`
helper emits the same events when an operation is driven locally.

## Layout

```text
packages/server/
├── src/
│   ├── index.ts        # public exports (library surface)
│   ├── bin.ts          # standalone `netpro-server` executable
│   ├── serve.ts        # runServe(): netpro serve composition + banner
│   ├── app.ts          # composition root
│   ├── config.ts       # host/port/autoMigrate (env > config.toml > defaults)
│   ├── server.ts       # listen / shutdown
│   ├── routes/
│   │   ├── health.ts
│   │   ├── contacts.ts      # GET|POST /api/contacts
│   │   ├── credentials.ts   # GET|PUT|POST|DELETE /api/credentials*
│   │   ├── search.ts        # GET /api/search
│   │   ├── graph.ts         # GET /api/graph* + pathfinder
│   │   ├── analytics.ts     # GET /api/analytics*
│   │   ├── import.ts        # POST /api/import
│   │   ├── scan.ts          # POST /api/scan
│   │   ├── jobs.ts          # GET|POST /api/jobs*
│   │   ├── events.ts        # GET /api/events (SSE)
│   │   ├── calendar-events.ts # GET /api/events JSON fallback
│   │   └── settings.ts      # GET|PUT /api/settings
│   ├── middleware/     # request-id, JSON helpers
│   ├── jobs/           # job registry (Phase 7: queued → running → completed)
│   ├── events/         # event bus (Phase 8: SSE fan-out)
│   └── auth/           # local trust (Phase 5)
└── package.json
```

`index.ts` is a pure library surface: importing `@netpro/server` never
starts a server (the CLI bundles this package, so an import side effect
would be fatal). The executable entry is `bin.ts`.

## Scripts

```bash
npm run build -w @netpro/server
npm run typecheck -w @netpro/server
npm run test -w @netpro/server
npm run dev -w @netpro/server
```

## Programmatic use

```ts
import { runServe } from '@netpro/server';

const handle = await runServe({ port: 3777 });
await handle.stopped; // resolves on SIGINT/SIGTERM after graceful shutdown
```

Lower-level building blocks (`createApp`, `startServer`) remain exported.

## Dependency rule

```text
@netpro/core
     ↓
@netpro/server   ← HTTP / auth / jobs / SSE
     ↓
apps/web         ← visualization only (future)
```

Business rules stay in `@netpro/core`. Routes orchestrate; they do not reimplement search, graph, or import.
