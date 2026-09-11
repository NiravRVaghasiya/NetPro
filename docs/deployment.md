# Deploying NetPro

NetPro runs on your machine by default; deploying it is for when you want it
reachable from somewhere else. Two supported targets:

| Target | Database | Best for |
| --- | --- | --- |
| [Local / first run](getting-started.md) | SQLite file in `~/.netpro` | Everyday use, CLI + local Web UI — no credentials, no cloud |
| [Docker Compose](#docker-compose-self-hosting) | Postgres in the stack | A server you own — for remote access, a team, or a VPS |

Any Node host works: `npm run build` + `netpro migrate` + start the server.
NetPro has no platform-specific build step, no serverless requirement, and no
configuration that only applies to one provider. For the supported global CLI
package and the Docker release path, see [Phase 18 — Packaging](phase-18-packaging.md)
and [Phase 19 — Docker](phase-19-docker.md).

> **SQLite needs a filesystem that survives a restart.** It is the local
> default (and is fine on a VPS or in a container with a volume); a
> function-style runtime whose disk is per-instance must use Postgres. NetPro
> will run either where you point it — the choice is yours and is documented
> rather than inferred.

> **Authentication, in one paragraph.** Local NetPro needs no credentials at
> all: requests from `127.0.0.1` are the operator, identified by the
> installation identity in `~/.netpro/config.toml` (see
> [phase-5-authentication.md](phase-5-authentication.md)). A *deployed* Web UI
> is reachable from other machines, so pick a mode: `NETPRO_AUTH_MODE=github`
> (GitHub OAuth — the GitHub variables below become required) or
> `NETPRO_AUTH_MODE=open` when a reverse proxy, VPN, or private network already
> authenticates callers. `local` mode must never be published on a public
> interface for the Web UI.

---

## Deploying on a Node host (VPS, PaaS, container platform)

The recipe is the same everywhere:

```bash
# 1. Install and build (Turborepo, standard Node/npm — no platform CLI)
npm ci
npm run build

# 2. Point NetPro at a Postgres database
export DB_DIALECT=postgresql
export DATABASE_URL='postgresql://user:password@host:5432/netpro?sslmode=require'

# 3. Apply migrations once, as a release step
npm run db:migrate

# 4. Start the Web UI (Next.js standalone output)
npm run start -w apps/web            # or: node apps/web/.next/standalone/apps/web/server.js
```

### 1. Create a Postgres database

Any Postgres works — Neon, Supabase, RDS, or one you run yourself. Copy the
**connection string**.

Most managed providers require TLS but sign certificates with their own CA, so
their connection strings end in `?sslmode=require`. Keep that suffix — NetPro
maps it to "encrypt, don't verify the provider's CA", which is what those
providers mean. See [Database TLS](#database-tls) if you need strict
verification.

If your provider offers both a **direct** and a **pooled** (pgbouncer)
connection string, use the pooled one for `DATABASE_URL` when many instances
start at once, and set `NETPRO_SERVERLESS=1` so each instance keeps a
one-connection pool (see [Connection pooling](#connection-pooling)).

### 2. Choose how callers authenticate

| Mode | Set | Who gets in |
| --- | --- | --- |
| `local` (default) | nothing | Requests from the machine the server runs on. **Only** valid when the process is reachable on loopback (see the caveat in [phase-5-authentication.md](phase-5-authentication.md)). |
| `github` | `NETPRO_AUTH_MODE=github` + the GitHub variables below | Every caller signs in with GitHub. One account is the break-glass owner. |
| `open` | `NETPRO_AUTH_MODE=open` | Nobody is authenticated by NetPro — only correct behind your own auth (reverse proxy with sign-in, VPN, private network). |

`netpro serve` (the CLI server) has a fourth, `token`: every request needs the
access token from `~/.netpro/keys/access-token` (`netpro token`). The Web UI
maps `token` to `local` because a browser cannot attach a bearer token to a
navigation.

### 3. Set environment variables

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | ✅ (Postgres) | Your Postgres connection string |
| `DB_DIALECT` | Recommended | `postgresql` — never inferred; set it explicitly |
| `NETPRO_AUTH_MODE` | Recommended | `github` for a public deployment, `open` behind your own auth |
| `NEXTAUTH_SECRET` | For `github` | `openssl rand -base64 32` |
| `APP_URL` | For `github` | Your final HTTPS origin, e.g. `https://netpro.example.com` (sets `AUTH_URL`) |
| `GITHUB_CLIENT_ID` | For `github` | From your GitHub OAuth app |
| `GITHUB_CLIENT_SECRET` | For `github` | From your GitHub OAuth app |
| `NETPRO_OWNER_GITHUB_ID` | For `github` | Your **numeric** GitHub ID — `gh api users/YOUR_USERNAME --jq .id` |
| `NETPRO_AUTO_MIGRATE` | Recommended | `false` when you migrate as a release step — see [Migrations](#migrations) |
| `NETPRO_HOST` | For remote API | Bind address — `127.0.0.1` (default) or `0.0.0.0` to expose deliberately |
| `NETPRO_ALLOWED_ORIGINS` | For remote UI | CSV origin allow-list for a browser UI on another origin — see [checklist](#remote-exposure-checklist) |
| `NETPRO_RATE_LIMIT_MAX` / `_WINDOW_MS` / `_ENABLED` | Optional | Per-IP rate limit (default 600/min, on) |
| `NETPRO_HSTS` | Behind TLS | `true` to send `Strict-Transport-Security` (reverse proxy terminates HTTPS) |
| `NETPRO_WEBHOOKS_ALLOW_PRIVATE` | Optional | `1` to let webhooks deliver to localhost/LAN receivers deliberately |
| `NETPRO_SERVERLESS` | Optional | `1` when many short-lived instances share one database |
| `HUNTER_API_KEY`, `PDL_API_KEY`, `CLEARBIT_API_KEY` | Optional | Enrichment providers (BYO key) |
| `AI_PROVIDER`, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional | AI outreach drafting (BYO key) |
| `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_API_KEY` | Optional | Semantic search arm — see [Search](#search) |

Environment variables always win over `~/.netpro/config.toml` (where the
local-first `netpro init` / `netpro serve` path stores its settings — see
[local-first.md](local-first.md)). A container has no meaningful home-directory
config by default, so this table remains the source of truth for deployments.

In `github` mode, `NETPRO_OWNER_GITHUB_ID` is the break-glass owner: if it is
unset, membership in the bootstrap workspace decides who gets in. Get it wrong
and either nobody can sign in (fails closed, safe) or the wrong account can.
It is your numeric account ID, not your username and not the OAuth client ID.

### 4. Create the GitHub OAuth app (only for `github` mode)

**Settings → Developer settings → OAuth Apps → New OAuth App.**

- Application name: anything (`NetPro`)
- Homepage URL: `https://netpro.example.com`
- Authorization callback URL: `https://netpro.example.com/api/auth/callback/github`

Then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`,
`NETPRO_OWNER_GITHUB_ID`, and `APP_URL` to your origin. If the host assigns its
domain on the first deploy, deploy once, then update the callback URL and
`APP_URL`, then redeploy.

### 5. Verify

```bash
curl https://netpro.example.com/api/health
# {"status":"healthy","dialect":"postgresql","latencyMs":42,...}
```

`/api/health` and `/api/server-info` are public (terse readiness probes); the
private API answers `401` with `WWW-Authenticate: Bearer realm="netpro"` until
a caller is authenticated, and `/api/identity` names the installation to an
authenticated caller.

---

## Docker Compose (self-hosting)

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and APP_URL. That is enough to run.
# For a Web UI reachable from other machines, also set NETPRO_AUTH_MODE=github
# and the GitHub variables (see step 2 above) — local mode is loopback-only.
docker compose build
docker compose up -d
curl http://localhost:3000/api/health   # Web UI process
curl http://localhost:3777/api/health   # standalone NetPro API
```

The stack runs four services: `db` (Postgres 16), a one-shot `migrate` job,
`server` (`@netpro/server`, the stable API/jobs/SSE process), and `web` (the
Next.js UI). The web service waits for both migrations and the API health check,
so it never performs schema changes on a request path. The API is published on
`127.0.0.1:3777` and the UI on `127.0.0.1:3000` by default.

Notes on the defaults:

- **Postgres is not published to the host.** The app reaches it over the
  private compose network. Publishing `5432` on a cloud VM without a firewall
  exposes your database to the internet. Uncomment the `ports` block in
  `docker-compose.yml` only if you need local inspection, and bind it to
  `127.0.0.1`.
- **The web port is published on `127.0.0.1` only.** Local mode decides who is
  the operator from the request's Host header, so the default deployment must
  not be reachable from another machine. To expose it, set
  `NETPRO_AUTH_MODE=github` (or `open` behind your own auth) *and* publish a
  public interface deliberately — see
  [phase-5-authentication.md](phase-5-authentication.md).
- **`APP_URL` must be your real external origin when using `github` mode.** It
  sets `AUTH_URL` (and `NEXTAUTH_URL`); see [Host trust](#host-trust).
- For HTTPS, terminate TLS at a reverse proxy (Caddy, nginx, Traefik) in front
  of port 3000 and set `APP_URL` to the `https://` origin.

Upgrades:

```bash
git pull
docker compose build
docker compose up -d   # recreate the migrate job when the image changes; it is idempotent
```

---

## Migrations

Migrations are committed SQL under `packages/db/migrations/<dialect>` and are
applied journal-based and idempotently — re-running is a no-op.

Two ways to apply them:

```bash
# Explicit (recommended for production)
npm run db:migrate
node apps/cli/dist/index.js migrate --status   # report without changing anything

# Automatic, on process startup (the default; good for local and Docker)
NETPRO_AUTO_MIGRATE=true
```

**On serverless, prefer the explicit step and set `NETPRO_AUTO_MIGRATE=false`.**
A deploy cold-starts many instances at once, and each one would otherwise try
to migrate. NetPro serializes that with a Postgres advisory lock so it is safe
either way — but running it once at build time means a migration failure fails
the *deploy* instead of returning 500s to your users, and request paths never
execute DDL.

> That advisory lock is not theoretical. Against a real PostgreSQL server with
> six concurrent migrators on a fresh database, the unguarded path failed five
> of six workers (`CREATE TABLE "account"`, and even
> `CREATE SCHEMA IF NOT EXISTS "drizzle"` — `IF NOT EXISTS` races with itself,
> because the check and the create are not atomic). The regression test lives
> in `packages/db/src/postgres.integration.test.ts` and runs in CI.

> **Pooled connection strings.** Managed providers attach a *pooled* URL
> (Neon: host contains `-pooler`, port 6543) — right for many short-lived
> instances, but
> a session-level advisory lock can leak across a transaction pooler: the
> unlock may land on a different backend than the one holding the lock, and
> the stale holder blocks the next migration for up to 60 s. The build-time
> migration step detects this and automatically uses the direct endpoint
> (stripping `-pooler`, port 5432), falling back to the pooled URL if the
> direct one is unreachable. Runtime auto-migration has no such escape hatch —
> with a pooled `DATABASE_URL`, set `NETPRO_AUTO_MIGRATE=false` and let the
> build step own migrations.

---

## Remote exposure checklist

`netpro serve` is safe by default: it binds `127.0.0.1`, trusts only the local
machine, answers browsers only from loopback origins, and rate-limits every
peer. Each step below is one deliberate decision away from that default — make
them in order, and `netpro serve` names the resulting policy on every remote
start so the console always shows what you chose.

1. **Bind.** `--host 0.0.0.0` (or `NETPRO_HOST`, or `[server] host` in
   `config.toml`) is the only way off loopback. A remote bind with no access
   token mints one rather than serve strangers.
2. **Authenticate.** `local` mode: remote callers present the access token
   (`netpro token`, `Authorization: Bearer`). `open` mode answers anyone —
   correct only behind a proxy/VPN that authenticates first; the server warns
   on every start. Web UI sessions (`github` mode) need `NEXTAUTH_SECRET` plus
   the OAuth variables in §3, and `APP_URL` must be the final HTTPS origin or
   Auth.js fails with `UntrustedHost`.
3. **Terminate TLS.** The server speaks plain HTTP; put nginx/Caddy/Traefik in
   front for anything beyond a trusted LAN, forward `X-Forwarded-Host` and
   `X-Forwarded-Proto`, and set `NETPRO_HSTS=true` so browsers remember the
   secure origin.
4. **Name browser origins.** With no allow-list, only loopback pages
   (`http://localhost:3000`, …) get CORS grants. A UI on another origin needs
   `NETPRO_ALLOWED_ORIGINS=https://ui.example.com` (or `allowed_origins` in
   `[server]`) — exact matches, no wildcards; naming a list replaces the
   loopback default, so include loopback too if local dev must keep working.
5. **Keep the rate limit on.** 600 requests/minute per IP by default; probes
   (`/api/health`, `/api/server-info`) and CORS preflights are exempt so
   monitors and browsers never trip it. Tune with `NETPRO_RATE_LIMIT_MAX` /
   `_WINDOW_MS`; `NETPRO_RATE_LIMIT_ENABLED=0` disables it (prefer raising the
   budget).
6. **Guard the database.** `DATABASE_URL` credentials never appear in `netpro
   status`, `/api/settings`, or logs (displays are redacted). For a managed
   Postgres, append `?sslmode=require` (or stricter — see [Database
   TLS](#database-tls)); in-Docker Postgres on a private network needs no TLS.
7. **Keep files owner-only.** The install directory (`~/.netpro`), database,
   access token, backups, exports, and the vault master key are `0700`/`0600`
   by default — verify with `ls -la ~/.netpro` after moving data between
   machines, and never commit `.env` or `config.toml` to git.
8. **Treat webhooks and plugins as privileged.** Webhook URLs cannot point at
   private networks unless `NETPRO_WEBHOOKS_ALLOW_PRIVATE=1` (see
   [webhooks.md](webhooks.md)); plugins run in-process with full data access,
   so `plugin enable` warns every time — enable only code you trust.

## Configuration reference

### Host trust

Auth.js v5 decides whether to trust the incoming `Host` header from
`AUTH_URL`, `AUTH_TRUST_HOST`, or a non-production `NODE_ENV` — **not** from
`NEXTAUTH_URL`. Because NetPro documents `NEXTAUTH_URL`, it also treats a
configured `NEXTAUTH_URL` as an explicit statement of trust
(`apps/web/lib/trust-host.ts`); naming your own origin is the same decision
`AUTH_TRUST_HOST` asks for. This only matters in `NETPRO_AUTH_MODE=github`;
local mode never asks Auth.js for a session.

If you see this in your logs, one of those values is missing:

```
[auth][error] UntrustedHost: Host must be trusted. URL was: .../api/auth/session
```

Behind a reverse proxy, make sure it sets `X-Forwarded-Host` and
`X-Forwarded-Proto` correctly — card writes enforce same-origin using them.
Set `AUTH_TRUST_HOST=false` to force trust off if your proxy is untrusted.

### Database TLS

`DATABASE_URL`'s `sslmode` is honoured (as is `PGSSLMODE`):

| `sslmode` | Behaviour | Use when |
| --- | --- | --- |
| `require` / `prefer` / `allow` | Encrypt, don't verify the certificate | Supabase, Neon, most managed providers |
| `verify-full` / `verify-ca` | Encrypt **and** verify against Node's trust store | Provider uses a publicly trusted CA |
| `disable` | No TLS | Private network, e.g. Docker Compose |
| *(unset)* | Let the driver and server negotiate | Plain local Postgres |

Set `NETPRO_DB_SSL_CA` to a CA certificate to verify against your provider's
own CA — the strongest option, and it overrides a lax `sslmode`.

### Connection pooling

Each instance keeps its own pool, sized automatically: **1** connection when
`NETPRO_SERVERLESS=1` (or a function runtime sets
`AWS_LAMBDA_FUNCTION_NAME`/`FUNCTION_TARGET`), **10** on a long-lived server.
Override with `NETPRO_DB_POOL_MAX`, `NETPRO_DB_POOL_IDLE_MS`, and
`NETPRO_DB_CONNECT_TIMEOUT_MS`.

If you hit connection limits on a free managed tier, use your provider's
pooled/pgbouncer connection string rather than raising `NETPRO_DB_POOL_MAX`.

### Health checks

`GET /api/health` is public and returns:

| Status | HTTP | Meaning |
| --- | --- | --- |
| `healthy` | 200 | Database reachable and fully migrated |
| `degraded` | 503 | Reachable, but migrations are missing |
| `unhealthy` | 503 | Not reachable |

Point your load balancer or uptime monitor at it. Anonymous responses omit
diagnostic detail on purpose — driver errors can contain hostnames and
database names. Add `?verbose` **while signed in as the owner** to see
migration counts, the underlying error, and a `search` block reporting which
engine your instance is actually serving (`portable` / `keyword` / `hybrid`)
plus index coverage — the fastest way to confirm a `netpro reindex` landed.

### Search

Search has three engines. They stack, and each one is opt-in on top of the
last, so **an instance that configures nothing behaves exactly as it did in
v1**.

| Engine | Requires | What you get |
| --- | --- | --- |
| `portable` | Nothing | ANSI-SQL substring matching over name, email, headline, company, role, location. The v1 behaviour, both dialects. |
| `keyword` | Migration `0004` + `netpro reindex` | SQLite FTS5 / Postgres `tsvector` over the full document — **also** notes, tags, industry, seniority, department, country — with prefix matching and BM25/`ts_rank` ordering. No key, no network, no cost. |
| `hybrid` | The above + `EMBEDDINGS_*` on Postgres | Adds a vector arm; the two ranked lists are merged with reciprocal rank fusion (k=60). |

```bash
# One-off after deploying 0004 — builds the keyword index for existing rows.
netpro reindex

# Optional: also write embeddings (costs one API call per batch of 64).
netpro reindex --embeddings

# What is my instance actually serving?
netpro reindex --status
```

Imports keep the keyword index current automatically; **imports never call an
embedding provider**, so a large CSV can't run up a bill. Re-run
`netpro reindex --embeddings` after a big import, or on a schedule.

| Variable | Default | Notes |
| --- | --- | --- |
| `EMBEDDINGS_PROVIDER` | `disabled` | `openai` or `disabled`. Anything else is treated as `disabled` by the web app (a typo must not 500 a page) and is a hard error in the CLI. |
| `EMBEDDINGS_API_KEY` | — | Falls back to `OPENAI_API_KEY` **only** when `EMBEDDINGS_PROVIDER` is explicitly set. |
| `EMBEDDINGS_MODEL` | `text-embedding-3-small` | Change it and the next `reindex` re-embeds; vectors from other models are ignored, never mixed. |
| `EMBEDDINGS_BASE_URL` | OpenAI | Any OpenAI-compatible `/v1` endpoint (llama.cpp, LM Studio, a gateway). |
| `EMBEDDINGS_DIMENSIONS` | model default | Only for models supporting truncation. |

The key is read from the server environment only — it is never sent to the
browser, and the semantic toggle on `/search` simply doesn't render when no key
is configured. **SQLite has no vector support**: the semantic arm is skipped
there and `--semantic` degrades to keyword with a note, not an error. Same if
the embeddings API is down mid-request — you get keyword results and a reason,
never a failed search.

### Skills (v2.0 Phase 5)

Skills are **derived, not typed in**. `netpro skills extract` (or
`POST /api/skills/extract`) matches each contact's headline, role, tags, custom
fields and notes against an embedded taxonomy — roughly 100 skills plus an
alias table, whole-token matching — and stores the result on the contact with
the field and snippet that produced every hit. Offline, no key, no network, no
cost. Re-runs are idempotent and only write rows that actually changed.

The AI pass is opt-in **per run**: `netpro skills extract --mode ai`, or
`{ "mode": "ai" }` on `POST /api/skills/extract`. It reads the same BYO key as
outreach — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in the server environment
(never sent to the browser), or the CLI keychain
(`netpro config set ai.openai.key sk-…`). It may only choose skills **from the
same taxonomy** — a model cannot invent one — and when the call fails or no key
is configured the run falls back to the heuristic result and says which it did.

Gaps, coverage and per-skill evidence live on `/skills`, in
`netpro skills [contact] | gap | status`, and in `GET /api/skills/gap`.

### Events (v2.0 Phase 6)

Import an attendee list with `netpro events import --file attendees.csv`
(`--dry-run` first) or from the `/events` page. Headers are alias-tolerant
(`Event Name` / `name`, `starts_at` / `date`, `attendees` / `Attendee Emails` /
`names`), attendee cells split on `,`, `;`, `|` and newlines, and dates accept
ISO, US and `Month D` forms — a date that is ambiguous or impossible
(`2026-02-31`) is rejected per row rather than guessed.

- Imports are **idempotent**: events dedupe on the normalized name and
  attendance on `(event, contact)`, so re-importing an updated list is safe.
- The `met_at_event` edges an import writes are **pending**. An attendee list is
  evidence of attendance, not of a meeting; confirm, merge or reject those
  candidates on `/edges`. Pairwise linking is capped at 250 edges per event per
  run and the run report says so when it stops.
- Attendee lines that match nobody are **parked on the event**, not dropped.
  After importing the missing contacts, re-run
  `netpro events match "<event>" --apply` (or use the re-match panel on
  `/events/[id]`) to link them.
- No migration was required: these are Phase 1's `events` / `event_attendees`
  tables finally getting a producer.

### Graph (v2.0 Phases 2–3)

The graph is computed **in the web process, per request**: confirmed edges are
loaded, communities (Louvain), centrality, components and warm-intro candidates
are built in TypeScript, and the page is rendered server-side. It is not cached
and not incremental — that is a deliberate simplicity/size trade.

- Sizing: comfortable to ~50k edges, the documented cap; past it the surface
  degrades with a notice instead of hanging. Betweenness (O(V·E)) and exact
  average path length have their own smaller node budgets and are skipped with
  a stated reason, so a large network never turns into a slow request.
- Measured rather than assumed (Phase 7): **5k contacts / 20k edges against a
  real PostgreSQL server** gave ~330 ms for the dashboard overview, ~210 ms for
  `GET /api/graph/overview`, ~10 ms per pathfinder plan, and ~30 ms for a
  keyword or hybrid search. Numbers are in the
  [Phase 7 progress doc](superpowers/plans/2026-09-08-v2.0-phase7-release-progress.md);
  re-measure against your own database with
  `NETPRO_TEST_DATABASE_URL=… npm run test -w @netpro/core -- src/postgres.perf.test.ts`.
- Re-measured with the v2.5 Observer fixture (v2.5 Phase 7): the same
  database carrying **10k profile views + 1k content items + 5k engagement
  snapshots** on PostgreSQL 18.4 gave ~485 ms for the full dashboard payload
  (graph + views + content blocks included), ~67 ms with those three
  sections off, ~16 ms for the views overview behind `GET /api/card/views`,
  ~5 ms for the content list behind `GET /api/content` and ~41 ms for its
  overview query — all inside the plan's 500/100/100 ms budgets, no new
  indexes needed. Medians of 3 runs from the same perf pass; see the
  [v2.5 Phase 7 progress doc](superpowers/plans/2026-09-09-v2.5-phase7-release-progress.md).

### Profile view tracking (v2.5 Phase 2)

The public profile card sends one anonymous view beacon per visit
(`GET /api/card/pixel.gif` for non-JS clients, `POST /api/card/view` from
browsers that measure duration). Both endpoints are public, CORS-open
(`*`), and answer 200 in every failure mode — a broken or hostile beacon
request must never break the visitor's page.

| Variable | Default | Effect |
| --- | --- | --- |
| `NETPRO_VIEW_SALT` | `NEXTAUTH_SECRET`, then a built-in constant | Base salt for the daily-salted HMAC viewer hashes (`viewer_ip`, `viewer_fingerprint`). Set your own on a fresh install; the hashes are never reversible, and changing the salt later does not break anything — it only resets the 5-minute / 1-hour de-duplication windows and the owner-view lookback. |
| `NETPRO_DISABLE_VIEWS` | *(unset)* | `true` → the beacons keep answering exactly as usual (GIF 200, `{ counted: false, reason: "disabled" }`) but write no rows. The rest of the card, and the settings panel (which says "Disabled"), keep working. |

Operational notes:

- **Rate limiting is in-memory** (60 requests/minute per salted IP hash,
  per server process). Where several instances run behind a load balancer
  the limit applies per instance — that is the documented, bounded behaviour
  from the plan (no Redis). Overflow still gets the GIF, just not a row.
- **IP and geo come from your reverse proxy.** The beacon reads the first
  `X-Forwarded-For` entry (or `X-Real-Ip`) and the generic `x-geo-country` /
  `x-geo-city` headers (Cloudflare's `cf-ipcountry` / `cf-ipcity` are also
  understood); NetPro never runs a geo lookup and never stores or logs a raw
  IP — only the 16-hex daily salted HMAC.
- **De-duplication:** the same visitor fingerprint within 5 minutes, or the
  same IP hash + page within 1 hour, is recorded once. Tab-refresh storms
  and double beacons do not inflate counts.
- **`DNT: 1` / `Sec-GPC: 1`** requests are still counted (respect, not
  refuse) but stored in minimal mode: page, time and bot flag only.
- Embed snippets on a blog or portfolio come from **Settings → Card →
  Tracking** on your instance's origin; HTML cards can opt into a pixel via
  `netpro card --pixel-url <origin>` (the card's CSP is extended with
  `img-src <origin>`).

### Viewer analytics (v2.5 Phase 3)

The query side of tracking is owner-only and cheap: `GET /api/card/views`
(windowed stats + recent timeline + known-visitor matches), a `views` block
inside `GET /api/analytics` (opt out per request with `?views=0` to slim
the payload), a strip on `/dashboard`, and the full tables on
**Settings → Card** (7/30/90-day windows, show/hide-bots). The CLI mirrors
it with `netpro card --views` and `netpro analyze --views`.

- **Every surface reads one core composition** (`getViewsOverview`), so the
  CLI, the API, and the pages can never disagree about a count.
- **Bots and owner views are excluded by default**, and the excluded counts
  travel in every payload — "0 views" never silently hides filtered rows.
- **The window caps at 90 days**, the raw-view retention bound; wider
  requests clamp (web) or fail validation (CLI/core) rather than
  under-reporting purged history. The daily purge job that enforces the
  bound runs in the web process — see [Data retention](#data-retention-v25-phase-6).
- Measured: **~23 ms for the full stats payload at 10k views on SQLite**
  (plan budget: 100 ms). No new indexes were needed — Phase 1's five
  `profile_views` indexes cover the analytics queries.

### Content tracker (v2.5 Phases 4–5)

The cross-posting tracker (`/content`, `netpro content`, `GET /api/content`)
needs no configuration to use: `manual` and `rss` are built in, and nothing
makes a network call you did not trigger.

| Variable | Default | Notes |
| --- | --- | --- |
| `DEVTO_API_KEY` | *(unset)* | **Reserved** — the `devto` provider ships as a disabled stub in v2.5; setting the key changes nothing until a provider implementation lands. |
| `TWITTER_BEARER_TOKEN` | *(unset)* | **Reserved** — same as above for `twitter`. |
| `GITHUB_TOKEN` | *(unset)* | **Reserved** — same as above for `github`. |

When a provider is disabled, `netpro content fetch` and the web's fetch path
explain exactly which key would enable it (`not_configured`) — they never
fail cryptically, and no provider polls or sweeps in the background:
`fetchMetrics` is always an explicit, per-item call.

### Data retention (v2.5 Phase 6)

Two bounded tables are purged by a daily job that runs in the **web
process** — in-memory, no queue, no new migration:

| Table | Window | Rule |
| --- | --- | --- |
| `profile_views` | 90 days | Raw rows older than the window are deleted. Aggregated analytics (Phase 3) are what live longer. |
| `content_metrics` | 365 days | Snapshots older than the window are deleted, **but the latest snapshot per content item always survives**, even when it is older than the window. |

How the cadence works: each run stamps one `activity_log` row
(`action = 'retention.purge'`, deleted counts in its metadata — never one
row per deleted row). The job reads that row before acting and skips when a
purge ran within the last 24 h. So:

- a **Docker instance** purges at boot and then on a 24 h timer;
- a **serverless deploy**'s cold starts all re-check the audit log and
  collapse into one purge per day;
- concurrent cold starts that both see "due" in the same second both delete
  (idempotent — the second removes nothing) and both log. A duplicate costs
  one extra zero-count row; correctness never depends on the race.

The schedule starts in `instrumentation.ts` after the startup migrations and
is independent of `NETPRO_AUTO_MIGRATE` (it is DML, not DDL). A purge
failure is logged and swallowed — it never affects request paths.

| Variable | Default | Notes |
| --- | --- | --- |
| `NETPRO_DISABLE_RETENTION` | *(unset)* | `true` → the schedule never starts; nothing is purged. |
| `NETPRO_VIEW_RETENTION_DAYS` | `90` | Raw-view window. Positive integers only; garbage/zero/negative values fall back to the default (a typo must not widen the window to "delete everything"). |
| `NETPRO_CONTENT_METRIC_RETENTION_DAYS` | `365` | Content-snapshot window; same lenient parsing. |

The Settings → Card tracking panel shows the effective windows, so the UI
and the job can never promise different horizons.

### Security headers

Every response carries a Content-Security-Policy, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`. HSTS is added
only when `NODE_ENV=production`, since sending it over plain HTTP would make a
local instance unreachable for two years. `/api/*` and `/card/*` are
additionally marked no-store so no shared cache or CDN retains private data.

---

## Production checklist

- [ ] `DB_DIALECT=postgresql` with a managed Postgres `DATABASE_URL` (never SQLite)
- [ ] A deliberate `NETPRO_AUTH_MODE` — `github` (or `open` behind your own auth) for anything reachable beyond loopback
- [ ] `NEXTAUTH_SECRET` generated with `openssl rand -base64 32`, unique to this instance (github mode)
- [ ] `netpro reindex` run once after deploying (search falls back to substring matching until it is)
- [ ] `NETPRO_OWNER_GITHUB_ID` is your numeric GitHub ID, and you can sign in (github mode)
- [ ] Anyone else's GitHub account is rejected at sign-in
- [ ] `NEXTAUTH_URL` (or `AUTH_URL`) matches your real HTTPS origin (github mode)
- [ ] OAuth callback URL registered as `<origin>/api/auth/callback/github`
- [ ] `/api/health` returns `healthy`
- [ ] `/api/card` returns 401 when signed out
- [ ] `/api/events` returns 401 when signed out (every `/api` route is owner-only)
- [ ] The web process can hold your graph in memory (comfortable to ~50k edges; see [Graph](#graph-v20-phases-23))
- [ ] Postgres is not reachable from the public internet
- [ ] Migrations run as a deploy step, with `NETPRO_AUTO_MIGRATE=false`
- [ ] You have a database backup/restore plan — NetPro does not make backups

---

## Troubleshooting

**`UntrustedHost` in the logs, every request 401s, `/api/auth/providers`
returns a configuration error.** Set `NEXTAUTH_URL` (or `AUTH_URL`) to your
external origin and restart. See [Host trust](#host-trust).

**`SELF_SIGNED_CERT_IN_CHAIN` / `unable to verify the first certificate`.**
Your provider signs with its own CA. Append `?sslmode=require` to
`DATABASE_URL`, or set `NETPRO_DB_SSL_CA`.

**`The server does not support SSL connections`.** The opposite case — append
`?sslmode=disable` for a private-network database.

**`/api/health` reports `degraded`.** The schema is missing. Run
`npm run db:migrate` (or `docker compose up migrate`).

**Sign-in immediately returns to the login page with "not authorized".**
`NETPRO_OWNER_GITHUB_ID` does not match the account you signed in with.
Confirm it with `gh api users/YOUR_USERNAME --jq .id` — it is a number.

**`too many connections` on a free Postgres tier.** Switch `DATABASE_URL` to
your provider's pooled connection string.

**Data disappeared after a redeploy.** You were running SQLite on an ephemeral
filesystem (a container whose writable layer or volume was replaced). Move to
Postgres, or give the SQLite file a persistent volume and set `DB_PATH` at it.

## Encrypted web provider keys (v3.0 Phase 4)

Set `ENCRYPTION_MASTER_KEY` to a cryptographically random secret of at least
32 characters (`openssl rand -hex 32`), then open **Settings → Provider keys**.
Store the master in your deployment secret manager, separately from database
backups. It must be identical on all web replicas. No new runtime dependency
or external vault service is required.

- **Personal** keys belong to the authenticated user in the active workspace;
  members, admins, and owners can save/remove their own keys. Viewers can see
  masked status but cannot modify keys.
- **Workspace** keys are shared for provider use; only admins/owners can
  save/remove them. Other users' personal credentials are never listed.
- Resolution is **personal vault → workspace vault → server environment**.
  This applies to outreach, AI skills extraction, enrichment, and hybrid-search
  embeddings. Model/base-URL/provider switches remain operator env settings;
  embeddings still require `EMBEDDINGS_PROVIDER=openai` and an indexed corpus.
  `embeddings.openai` maps to `EMBEDDINGS_API_KEY`, with the existing
  `OPENAI_API_KEY` fallback (including the resolved `outreach.openai` slot).
- Credentials are encrypted with AES-256-GCM, random 96-bit IVs, and a
  SHA-256-derived key bound to the workspace, nullable user, and provider slot.
  Moving ciphertext to another principal or slot fails authentication.
  Management responses return only slot, principal, final four characters,
  update time, and last-used time, never ciphertext or plaintext. A submitted
  value must be at least eight characters so its four-character mask cannot
  expose the whole key.
- `last_used_at` means **resolved for a provider operation**, not proof of a
  successful external API call. Capability/status rendering never decrypts
  a key or updates its usage timestamp.
- If the master is absent/short, management is read-only and providers use env
  credentials only. Existing ciphertext is retained, not deleted. A configured
  but wrong master (or damaged ciphertext) fails closed: restore the correct
  master or overwrite the affected slot. It does **not** silently charge the
  env credential instead.
- Back up the master securely. There is no automatic rotation/re-encryption
  command in this phase: keep the existing master, or replace every vault
  credential when changing it. Losing both the master and the original provider
  keys makes recovery impossible. Plaintext is not recoverable from the UI.
- CLI keys remain in the encrypted local `~/.netpro` keychain: **CLI is you;
  web is shared**. The new web vault does not change CLI keychain behavior.
- Reserved `content.devto`, `content.twitter`, and `content.github` slots can be
  stored, but their existing content adapters are disabled stubs; saving a key
  does not enable fetching. Core also accepts `plugin.<id>` slots for the
  forthcoming plugin runtime; the current UI lists built-in slots only.

Migration `0009_key_vault` is additive on SQLite and PostgreSQL. Two partial
unique indexes enforce one key per personal slot and one per workspace slot
(SQL `UNIQUE` on a nullable user alone would allow duplicate shared keys).
Deleting a workspace or Auth.js user cascades to its vault rows. Deleting a
workspace membership alone retains that user's encrypted personal rows for
possible rejoining; revoked users cannot access the authenticated vault API.

**Scope boundary:** this phase scopes the vault, not the rest of the CRM.

## Workspace-scoped CRM engine (v3.0 Phase 2)

Phase 2 begins the application-wide query scoping with the shared CRM. Every
CRM query (contacts, interactions, follow-ups, timeline, activity log, contact
resolution) now carries an explicit `workspace_id` predicate, and CRM writes
stamp the workspace plus a `created_by_user` author from the authenticated
principal. The scope is resolved server-side from the session — a request can
never supply its own `workspace_id`. Web CRM API routes
(`/api/interactions`, `/api/follow-ups`, `/api/contacts`,
`/api/contacts/[id]`) call the new `requireScope()` helper and pass it down.

- **Single-owner compatibility:** with no scope specified (e.g. the CLI,
  which talks to the database directly), every query resolves to the bootstrap
  `default` workspace — identical behavior to v2.5. Operator-grade CLI commands
  can address any workspace once a `--workspace` selection is added.
- **Workspace default:** migration `0011_workspace_default` backfills any rows
  whose `workspace_id` is `NULL` into the bootstrap workspace (both dialects)
  and, on PostgreSQL, attaches a DB-level `DEFAULT 'default'` to `workspace_id`
  on every data table. Phase 1's `0008` added the column as *nullable* with no
  default, so a new Postgres insert that omitted `workspace_id` produced NULL —
  which the scoped queries then hid. This migration closes that gap so a fresh
  or upgrading single-owner install keeps seeing its own data.
- **Authorship:** migration `0010_authorship` adds `created_by_user` to
  `interactions` and `follow_ups` (both dialects) plus author indexes. Existing
  rows are left `NULL`; new writes record the workspace user id.
- **Still pending in Phase 2:** query scoping for analytics, search, views,
  content, graph, events, campaigns; scoped retention/reindex/beacons; CLI
  `--workspace` + config binding; and per-user vs per-workspace GDPR. Until
  those land, do not treat the CRM scoping as certification of multi-tenant
  isolation for the other routes.

## Plugin marketplace (v3.0 Phase 6)

The marketplace is a **static index with checksums, not a curated store**.
The default index is `marketplace/index.json` in this repo; fetching it is a
plain GET with a static user agent — no accounts, no install telemetry. Every
install is verified five ways before it lands, and always lands **disabled**:
enabling requires the explicit permissions review (`--i-have-reviewed-permissions`
on the CLI, a confirm checkbox in `/settings/plugins`).

| Knob | Default | Meaning |
|---|---|---|
| `MARKETPLACE_INDEX_URL` | this repo's raw `marketplace/index.json` | Index location: https, `file://`, or a plain path. |
| `NETPRO_PLUGIN_DIR` | `./plugins` (+ repo-root `./plugins` when present) | Where plugins install and load from. Set this explicitly in production. |
| `MARKETPLACE_NO_CACHE` | unset (1-hour local cache) | `true` disables the local index cache. |
| `MARKETPLACE_CACHE_PATH` | OS cache dir (`~/.cache/netpro/…`) | Override the cache file (tests, read-only homes). |

```bash
# Discover and install the reference plugin (offline-friendly: file:// works)
netpro plugin search event
MARKETPLACE_INDEX_URL=file://$PWD/marketplace/index.json netpro plugin install example-event-discovery
netpro plugin enable example-event-discovery --i-have-reviewed-permissions
netpro plugin update example-event-discovery   # no-op when current; --force to downgrade
netpro plugin rm example-event-discovery       # unregisters AND deletes the files
```

**Verification on every install/update:** (1) the index parses as schema 1
(size-capped at 256 KiB, 1000 entries); (2) the tarball sha256 matches the
index entry — mismatch is a hard, audited refusal; (3) the archive extracts
cleanly (vendored USTAR reader: no symlinks, no `..`/absolute escapes,
8 MiB compressed / 32 MiB inflated / 1000 files / 8 MiB per file) with a
`manifest.json` at its root; (4) the manifest's name, version, and
permissions match the index listing exactly; (5) the engine range accepts
this NetPro. Git sources (https/file only, non-interactive) verify the
checked-out HEAD against the pinned 40-char commit.

**Self-hosting:** copy `marketplace/` to any static host (GitHub Pages, S3, a
file share) and set `MARKETPLACE_INDEX_URL` to your `index.json`. Tarball
URLs may be relative to the index, so the mirror works with no edits. See
`marketplace/README.md` for the entry format and the tarball rebuild
commands. Credential-bearing URLs are refused anywhere in the chain.

**Ephemeral filesystem note:** web installs write to `NETPRO_PLUGIN_DIR`,
which disappears when a container is replaced — install via the CLI into a
directory baked into the image (the Docker image ships `plugins/` +
`marketplace/`), or mount a persistent volume for self-hosted Docker.

**Audit events:** `plugin.installed`, `plugin.install_failed` (with `reason`),
`plugin.updated`, `plugin.update_failed`, `plugin.update_refused`,
`plugin.removed` (with `filesRemoved`) — all in `activity_log`, filterable in
`/settings/activity`.

## Outbound webhooks (v3.0 Phase 7)

Outbound only: NetPro signs and POSTs events to endpoints **you** register —
there is no inbound ingestion. Admins manage endpoints in `/settings/webhooks`
or with `netpro webhook`; concepts, receiver recipes and signature-verification
examples live in [webhooks.md](webhooks.md).

| Knob | Default | Meaning |
|---|---|---|
| `NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | Delivery-log rows older than this are purged by the daily retention job. Garbage values fall back to the default. |
| `NETPRO_DISABLE_RETENTION` | unset | `true` stops the daily job entirely — raw views, content snapshots **and** webhook deliveries. |

**Delivery contract:** `POST` with `content-type: application/json`,
`user-agent: NetPro-Webhooks/3.0`, `X-NetPro-Signature: t=<unix>,v1=<hex
HMAC-SHA256 over "<t>.<body>">`, `X-NetPro-Event: <event>` and
`X-NetPro-Delivery: <id>`. The body is
`{ schema: 1, event, workspace_id, actor, timestamp, data }`, rejected at emit
time above 256 KB. 10 s timeout; anything that is not a 2xx is recorded with
its status code and error.

**Retries are on demand, not scheduled.** `emitWebhookEvent` attempts each
matching endpoint immediately, and a failure leaves the delivery `pending`
until `attempt` reaches `max_attempts` (8), after which it stays `failed`.
`netpro webhook retry` then drains the backlog — oldest first, at most 50 per
run — and `netpro webhook redeliver <deliveryId>` re-sends one by hand.
Nothing polls on its own, so a serverless deployment that receives no traffic
will not drain the queue: schedule the CLI (cron, CI) or redeliver from
`/settings/webhooks`.

**Egress is your responsibility.** `createWebhook` refuses non-http(s) URLs,
URLs carrying credentials and URLs over 2048 characters. The private-network
check (`localhost`, `127.0.0.1`, `::1`, `10.*`, `192.168.*`, `172.16–31.*`,
`0.0.0.0`, `*.local`, `*.internal`) is a **CLI warning** over the hostname
only — it never resolves DNS, and the web API does not enforce it. An admin
can therefore register an internal target, so confine egress at the network
layer (reverse proxy / firewall) if that matters to you.

```bash
netpro webhook events                        # the 18 events + receiver recipes
netpro webhook add https://hooks.example.com/netpro --events contact.created,followup.created
netpro webhook list
netpro webhook test <webhookId> --event contact.created   # a real signed POST
netpro webhook deliveries <webhookId> --limit 20
netpro webhook retry                         # drain the pending backlog
netpro webhook redeliver <deliveryId>
netpro webhook rotate <webhookId>            # new secret, printed once
netpro webhook disable <webhookId>           # enable <id> to resume
netpro webhook rm <webhookId>
```

There is no CLI `update`: change the URL or event allowlist from
`/settings/webhooks` (or `PATCH /api/webhooks/[id]`).

**Audit events:** `webhook.created`, `webhook.updated`,
`webhook.secret_rotated`, `webhook.deleted`, `webhook.event_emitted`,
`webhook.redelivered` — all in `activity_log`, filterable in
`/settings/activity`.
