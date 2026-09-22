# API contracts

The HTTP + SSE contract the Web UI and `netpro serve` already depend on. Python FastAPI (Phase 12) must preserve these shapes unless a versioned break is explicitly documented.

Source of truth in TypeScript: `packages/server/src/routes/index.ts`, `packages/server/README.md`, route handlers under `packages/server/src/routes/`.

---

## Transport

| | |
| --- | --- |
| Server | `node:http` (no Express/Fastify) |
| Default bind | `127.0.0.1:3777` |
| Content type | `application/json; charset=utf-8` |
| Cache | `Cache-Control: no-store, max-age=0` on JSON |
| Request id | Assigned on every request; echoed |
| Body limits | 16 KiB default JSON; imports up to 5 MiB |
| CORS | Only if **authenticated** and origin allowed (loopback default, or `NETPRO_ALLOWED_ORIGINS` / `[server] allowed_origins`). Methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Headers `Content-Type, Authorization, X-NetPro-Token, X-Request-Id` |
| OPTIONS | 204, not rate-limited |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; HSTS only when TLS (`hsts: true`) |
| Rate limit | 600 req / 60s / IP (fixed window). 429 `{ error, code: "rate_limited", retryAfterMs }` + `Retry-After`. Exempt: `GET` public probes and `OPTIONS`. Disable: `NETPRO_RATE_LIMIT_ENABLED=0` |

Unknown `/api/*` → **404 JSON** `{ error: "Not found: METHOD path" }` (never HTML).

---

## Authentication

Three modes (`NETPRO_AUTH_MODE` or `[auth] mode`, default `local`):

| Mode | Loopback (no `X-Forwarded-For` / `X-Real-Ip` / `Forwarded`) | Other peers |
| --- | --- | --- |
| `local` | Trusted operator | Bearer token required |
| `token` | Token required | Token required |
| `open` | Authenticated, **not** `trustedLocal` | Authenticated, not trusted |

Credential extraction (first match):

1. `Authorization: Bearer <token>`
2. `X-NetPro-Token: <token>`
3. `?token=` (EventSource cannot set headers)

Compare: SHA-256 both sides then `timingSafeEqual` (length not leaked).

**Public (no auth):**

- `GET /api/health` and `GET /health`
- `GET /api/server-info`

**401 body:**

```json
{
  "error": "Unauthorized",
  "reason": "missing-credentials" | "invalid-credentials",
  "authMode": "local" | "token" | "open",
  "hint": "…"
}
```

`WWW-Authenticate: Bearer realm="netpro"` when a token is configured.

Proxy headers **revoke** loopback trust (a reverse proxy on 127.0.0.1 is not the operator).

See fixture: [`fixtures/api/unauthorized.json`](fixtures/api/unauthorized.json).

---

## Route table

Aliases are first-class — the UI and CLI use several of them.

### Public

| Method | Path | Core | Response |
| --- | --- | --- | --- |
| GET | `/api/health`, `/health` | ping + optional migrations/search | See Health |
| GET | `/api/server-info` | — | `{ name, service, message, health, authMode, authenticationRequired }` |

### Identity & settings

| Method | Path | Core | Notes |
| --- | --- | --- | --- |
| GET | `/api/identity` | `readInstallationIdentity` | Never returns the token |
| GET | `/api/settings`, `/api/config` | `readLocalConfig` + `describeConn` | Server, database, auth, installation |
| PUT/PATCH | `/api/settings`, `/api/config` | — | Validates keys; returns file-managed guidance (does not rewrite toml from the API) |

### Contacts

| Method | Path | Core | Notes |
| --- | --- | --- | --- |
| GET | `/api/contacts` | `listCrmContacts` | `?limit=&offset=&sort=recent\|score\|name\|follow-up` |
| GET | `/api/contacts/:id` | `getContactTimeline` | 404 if missing/deleted |
| POST | `/api/contacts` | `addPersonFromLinkedIn` | `{ linkedinUrl, fullName? }` → 201 created / 200 exists. `{ dryRun: true }` validates without write |

### Credentials (vault)

| Method | Path | Core | Notes |
| --- | --- | --- | --- |
| GET | `/api/credentials` | `listVaultKeys` | Masked `lastFour` only + catalog |
| PUT | `/api/credentials/:provider` | `testProviderKey` + `saveVaultKey` | `{ apiKey }`; 422/502 leave stored key; 503 without `ENCRYPTION_MASTER_KEY` |
| POST | `/api/credentials/:provider/test` | `resolveVaultKey` + `testProviderKey` | Tests stored key; never returns it |
| DELETE | `/api/credentials/:provider` | `removeVaultKey` | |

Provider ids match vault slots: `outreach.openai`, `outreach.anthropic`, `enrichment.hunter`, `enrichment.pdl`, `enrichment.clearbit`, `embeddings.openai`, `content.devto`, `content.twitter`, `content.github`, plus `plugin.<name>`.

### Search / graph / analytics

| Method | Path | Core | Query |
| --- | --- | --- | --- |
| GET | `/api/search`, `/api/contacts/search` | `searchContacts` | `q`, `company`, `role`, `location`, `industry`, `seniority`, `hasEmail`, `minScore`, `activeWithin`, `skills`, `sort`, `limit`, `offset`, `mode=portable\|keyword\|hybrid` |
| GET | `/api/graph`, `/api/graph/overview`, `/api/graph/network` | `getNetworkGraph` | `limit`, `depth`, `relation`, `status`, `minConfidence` |
| GET | `/api/graph/path`, `/api/graph/paths` | `planIntroPaths` | **`target` required**; `from`, `k`, `depth` |
| GET | `/api/graph/visualization`, `/api/graph/data`, `/api/graph/viz` | visualization | same graph filters |
| GET | `/api/analytics`, `/api/analytics/network`, `/api/analytics/overview` | `getNetworkOverview` | `days`, `activeDays`, `months`, `limit`, `graph`, `views`, `content` |

### Import / scan / enrich

| Method | Path | Core | Notes |
| --- | --- | --- | --- |
| POST | `/api/import` | `runImport` | `multipart/form-data` `file` **or** JSON `{csv}` **or** `text/csv`; creates job `type: import` |
| POST | `/api/import/preview` | preview/validate | No write |
| GET | `/api/import/:id` | job registry | Alias of `GET /api/jobs/:id` |
| POST | `/api/scan` | `runScan` | Job `type: scan` |
| GET | `/api/scan/:id` | job | 404 if missing or not a scan |
| POST | `/api/enrich` | enrichment pipeline | Job `type: enrich` |
| GET | `/api/enrich/:id` | job | |

### Jobs

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/jobs` | `?type=&status=&limit=&offset=`; newest first |
| POST | `/api/jobs` | `{ type, metadata }` → 201 queued |
| GET | `/api/jobs/:id` | |
| POST | `/api/jobs/:id/cancel` | queued/running only |
| POST | `/api/jobs/:id` | `{ action: "cancel" }` alias; else 405 |

### Events (dual meaning)

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/api/events` | If `Accept: text/event-stream` → **SSE**. Else calendar events JSON |
| GET | `/api/events/stream` | Always SSE |
| POST | `/api/events/ingest` | CLI→server bridge: forward `job.*` into the bus |
| GET | `/api/events/:id` | Calendar event detail (`:id` ≠ `stream`) |

### Providers

| Method | Path | Core |
| --- | --- | --- |
| GET | `/api/providers`, `/api/providers/status` | `resolveProviderStatus` |

### Console

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Local console HTML (authenticated). CSP: no external assets. Unauthenticated → locked page |

---

## Health

Anonymous body (always):

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "dialect": "sqlite" | "postgresql",
  "latencyMs": 1,
  "timestamp": "2026-09-22T00:00:00.000Z"
}
```

- `SELECT 1` failure → 503 `unhealthy` (`error` is generic unless `trustedLocal`)
- Migrations incomplete / missing → 503 `degraded`
- `?verbose=1` **and** `trustedLocal` adds `migrations: { applied, expected }` and `search: { mode, indexed, contacts, embedded }`

Fixtures: [`health.json`](fixtures/api/health.json), [`health.verbose.json`](fixtures/api/health.verbose.json).

---

## Job model

```ts
type Job = {
  id: string;
  type: 'import' | 'scan' | 'enrich' | 'index' | 'embed' | 'graph' | 'analyze';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;            // 0–100 integer
  startedAt: string | null;    // + started_at
  completedAt: string | null;  // + completed_at
  error: string | null;        // failed only; capped 5000 chars
  metadata: Record<string, unknown>;
  createdAt: string;           // + created_at
  updatedAt: string;           // + updated_at
};
```

**Both casings are required** in JSON. Progress ladder for scan:

```text
0 queued → 15 discovering → 40 processing → 70 indexed
         → 90 enriching/analyzing → 100 completed
```

Registry is **in-memory per process**. Python may persist later; the HTTP shape must not change.

Fixture: [`job.json`](fixtures/api/job.json).

---

## SSE contract

`GET /api/events` with `Accept: text/event-stream` (or `/api/events/stream`):

```
retry: 3000
: connected

event: job.queued
data: {"type":"job.queued","jobId":"…","progress":0,"timestamp":"…","seq":1}
```

Envelope:

```ts
type NetProEvent = {
  type: string;
  jobId?: string;
  progress?: number;
  message?: string;
  timestamp?: string;  // ISO, bus-owned unless caller set it
  seq?: number;        // monotonic, bus-owned
  [key: string]: unknown;
};
```

Canonical `EVENT_TYPES` (UI may filter on these names):

```
job.queued  job.running  job.progress  job.completed  job.failed  job.cancelled
scan.started  scan.progress  scan.completed
contact.imported  contact.updated
relationship.discovered  relationship.updated
graph.updated
search.started  search.completed
enrichment.started  enrichment.completed
import.started  import.progress  import.completed
```

Replay: last **200** events to late joiners. Filter query params may exist on the stream (`type`, `jobId`) — preserve them.

Fixture: [`sse-event.txt`](fixtures/api/sse-event.txt).

---

## Representative domain responses

### POST `/api/contacts` created (201)

See [`contacts-created.json`](fixtures/api/contacts-created.json). `status: "exists"` with 200 when the normalized LinkedIn URL already matches a live contact (never a silent duplicate). `dryRun: true` returns the check without writing.

LinkedIn URL errors map to 400 with the human message from `LinkedInUrlError` (`empty | invalid_url | not_linkedin | unsupported_route`).

### Search

`SearchContactsResponse`:

```ts
{
  contacts: ContactSearchResult[];  // see packages/core/src/search/types.ts
  total: number;
  limit: number;                    // default 25, max 100
  offset: number;
  facets: { company, role, location, seniority, industry: { value, count }[] };
  engine: {
    mode: 'portable' | 'keyword' | 'hybrid';  // actually served
    requested: 'portable' | 'keyword' | 'hybrid';
    arms: { portable, keyword, semantic: { used, hits, reason?, detail? } };
    truncated: boolean;             // fused pool hit 500
  };
}
```

Arm skip reasons: `not_requested | index_empty | index_missing | not_configured | no_embeddings | provider_error`.

### Pathfinder

`target` missing → 400 GraphError `invalid_input`. Ambiguous name → 400. Unknown → 404. Origin defaults to strongest tie (`selectedBy: "strongest-tie"`). Each path includes `rank`, `score: { weakestTie, avgHopStrength, score }`, `ask: { contactId, fullName, suggestion, … }`.

### Analytics

Composite `{ metrics, score, growth, clusters, dormant, graph?, views?, content? }` from `getNetworkOverview`. Score is 0–100 with `factors: [{ key, value, weight }]`.

---

## Error format

JSON only. Typical fields:

```json
{ "error": "human message", "code": "not_found" }
```

Domain error codes (core) → HTTP:

| Code | HTTP |
| --- | --- |
| `invalid_input` / `validation` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `rate_limited` | 429 |
| body too large | 413 |
| wrong content-type | 415 |
| vault misconfigured | 503 |

Do not leak stack traces, SQL, file paths, or secrets. `trustedLocal` may see richer health diagnostics; `open` mode must not.

---

## CLI output contracts (for golden tests)

Commands that matter for Phase 0 capture (full help in [`fixtures/cli/commands.txt`](fixtures/cli/commands.txt)):

| Command | Stable facts |
| --- | --- |
| `netpro --version` | `3.0.2` |
| `netpro init` | Creates home, applies 15/15 migrations, writes identity + token |
| `netpro status` | install · database (redacted) · identity · server health · providers |
| `netpro serve` banner | `Local:` ends with `(API + built-in console)`; `Web UI:` is either configured URL or `not running` — never the API port |
| `netpro search … --json` | Same `SearchContactsResponse` as HTTP |
| `netpro path … --json` | Same `IntroPathPlan` as HTTP |
| `netpro analyze --json` | Same overview as `/api/analytics` |

`--json` is the golden-test surface. Human text may change; JSON must not without a documented break.

---

## What the API does **not** expose (CLI-only)

No HTTP routes yet for: campaigns, skills, events (beyond calendar JSON), content, team, plugins, webhooks, backup/restore, migrate, edge mutations, outreach compose.

Python should not invent these routes in early phases. Adding them is a product increment, not a compatibility requirement.

---

## Compatibility rules for FastAPI

1. Keep paths and aliases (including `/api/contacts/search`, `/api/graph/paths`, `/api/events` dual meaning).
2. Keep job camel+snake aliases.
3. Keep SSE event **names**.
4. Keep 401 body `{ error, reason, authMode, hint }`.
5. Keep health `{ status, dialect, latencyMs, timestamp }`.
6. If a breaking change is unavoidable, introduce `/api/v2` and leave `/api` working until the Next.js client is switched (plan Phase 14).
