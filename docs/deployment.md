# Deploying NetPro

NetPro is a **single-owner** application: one instance holds one person's
network, and exactly one GitHub account can sign in. It is not multi-tenant.
Deploy your own instance rather than sharing one.

Three supported targets:

| Target | Database | Best for |
| --- | --- | --- |
| [Vercel](#vercel-one-click) | Managed Postgres (Neon, Supabase, Vercel Postgres) | The quickest hosted setup |
| [Docker Compose](#docker-compose-self-hosting) | Postgres in the stack | Full self-hosting on your own box |
| [Local](getting-started.md) | SQLite file | Trying it out, CLI-only use |

> **SQLite is for local use only.** It is a file on disk: perfect for the CLI
> and local development, wrong for any serverless host. NetPro refuses to start
> with `DB_DIALECT=sqlite` on Vercel rather than silently losing your data on
> the next redeploy.

---

## Vercel (one-click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro&env=DB_DIALECT,DATABASE_URL,NEXTAUTH_SECRET,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,NETPRO_OWNER_GITHUB_ID&envDescription=NetPro%20needs%20a%20Postgres%20URL%2C%20an%20auth%20secret%2C%20a%20GitHub%20OAuth%20app%2C%20and%20your%20numeric%20GitHub%20user%20ID&envLink=https%3A%2F%2Fgithub.com%2FNiravRVaghasiya%2FNetPro%2Fblob%2Fmaster%2Fdocs%2Fdeployment.md&project-name=netpro&repository-name=netpro)

### 1. Create a Postgres database

Any Postgres works. Vercel's own integration, Neon, and Supabase all have a
free tier. Copy the **connection string**.

Most managed providers require TLS but sign certificates with their own CA,
so their connection strings end in `?sslmode=require`. Keep that suffix —
NetPro maps it to "encrypt, don't verify the provider's CA", which is what
those providers mean. See [Database TLS](#database-tls) if you need strict
verification.

If your provider offers both a **direct** and a **pooled** (pgbouncer)
connection string, use the pooled one for `DATABASE_URL`: serverless scales
out to many instances, and each one opens its own connections.

### 2. Set environment variables

| Variable | Required | Value |
| --- | --- | --- |
| `DB_DIALECT` | ✅ | `postgresql` |
| `DATABASE_URL` | ✅ | Your Postgres connection string |
| `NEXTAUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `GITHUB_CLIENT_ID` | ✅ | From your GitHub OAuth app |
| `GITHUB_CLIENT_SECRET` | ✅ | From your GitHub OAuth app |
| `NETPRO_OWNER_GITHUB_ID` | ✅ | Your **numeric** GitHub ID — `gh api users/YOUR_USERNAME --jq .id` |
| `NEXTAUTH_URL` | Recommended | Your final HTTPS origin, e.g. `https://netpro.example.com` |
| `NETPRO_AUTO_MIGRATE` | Recommended | `false` — see [Migrations](#migrations) |
| `HUNTER_API_KEY`, `PDL_API_KEY`, `CLEARBIT_API_KEY` | Optional | Enrichment providers (BYO key) |
| `AI_PROVIDER`, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional | AI outreach drafting (BYO key) |

`NETPRO_OWNER_GITHUB_ID` is the **only** access control. Get it wrong and either
nobody can sign in (fails closed, safe) or the wrong account can. It is your
numeric account ID, not your username and not the OAuth client ID.

### 3. Create the GitHub OAuth app

**Settings → Developer settings → OAuth Apps → New OAuth App.**

- Homepage URL: `https://your-app.vercel.app`
- Authorization callback URL: `https://your-app.vercel.app/api/auth/callback/github`

Vercel assigns the domain on the first deploy, so you may need to deploy once,
then update the callback URL and `NEXTAUTH_URL`, then redeploy.

### 4. Deploy

`vercel.json` points the build at `npm run vercel-build`, which
[migrates the database and then builds](#migrations). If `DATABASE_URL` is not
set yet on the very first build, migration is skipped with a warning and the
app migrates on first boot instead.

### 5. Verify

```bash
curl https://your-app.vercel.app/api/health
# {"status":"healthy","dialect":"postgresql","latencyMs":42,...}
```

`degraded` with HTTP 503 means the database is reachable but not migrated —
run the migration step. `unhealthy` means it is not reachable at all.

---

## Docker Compose (self-hosting)

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, NEXTAUTH_SECRET, the GitHub OAuth
# credentials, NETPRO_OWNER_GITHUB_ID, and APP_URL.
docker compose build
docker compose up -d
curl http://localhost:3000/api/health
```

The stack runs three services: `db` (Postgres 16), a one-shot `migrate` job,
and `web`. The web service waits for migrations to complete, so it never
performs schema changes on a request path.

Notes on the defaults:

- **Postgres is not published to the host.** The app reaches it over the
  private compose network. Publishing `5432` on a cloud VM without a firewall
  exposes your database to the internet. Uncomment the `ports` block in
  `docker-compose.yml` only if you need local inspection, and bind it to
  `127.0.0.1`.
- **`APP_URL` must be your real external origin.** It sets both `NEXTAUTH_URL`
  and `AUTH_URL`; see [Host trust](#host-trust).
- For HTTPS, terminate TLS at a reverse proxy (Caddy, nginx, Traefik) in front
  of port 3000 and set `APP_URL` to the `https://` origin.

Upgrades:

```bash
git pull
docker compose build
docker compose up -d   # the migrate job re-runs; it is idempotent
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

---

## Configuration reference

### Host trust

Auth.js v5 decides whether to trust the incoming `Host` header from
`AUTH_URL`, `AUTH_TRUST_HOST`, `VERCEL`, `CF_PAGES`, or a non-production
`NODE_ENV` — **not** from `NEXTAUTH_URL`. Because NetPro documents
`NEXTAUTH_URL`, it also treats a configured `NEXTAUTH_URL` as an explicit
statement of trust (`apps/web/lib/trust-host.ts`); naming your own origin is
the same decision `AUTH_TRUST_HOST` asks for.

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

Each instance keeps its own pool, sized automatically: **1** connection on
serverless (`VERCEL`/`AWS_LAMBDA_FUNCTION_NAME`), **10** on a long-lived
server. Override with `NETPRO_DB_POOL_MAX`, `NETPRO_DB_POOL_IDLE_MS`, and
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
migration counts and the underlying error.

### Security headers

Every response carries a Content-Security-Policy, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`. HSTS is added
only when `NODE_ENV=production`, since sending it over plain HTTP would make a
local instance unreachable for two years. `/api/*` and `/card/*` are
additionally marked no-store so no shared cache or CDN retains private data.

---

## Production checklist

- [ ] `DB_DIALECT=postgresql` with a managed Postgres `DATABASE_URL` (never SQLite)
- [ ] `NEXTAUTH_SECRET` generated with `openssl rand -base64 32`, unique to this instance
- [ ] `NETPRO_OWNER_GITHUB_ID` is your numeric GitHub ID, and you can sign in
- [ ] Anyone else's GitHub account is rejected at sign-in
- [ ] `NEXTAUTH_URL` (or `AUTH_URL`) matches your real HTTPS origin
- [ ] OAuth callback URL registered as `<origin>/api/auth/callback/github`
- [ ] `/api/health` returns `healthy`
- [ ] `/api/card` returns 401 when signed out
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
filesystem. Move to Postgres; NetPro now refuses this configuration on Vercel.
