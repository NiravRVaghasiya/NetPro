# Phase 19 — Docker self-hosted deployment

Docker Compose provides a persistent self-hosted NetPro instance with the
production Web UI, the local NetPro API surface, and PostgreSQL. It does not
use Vercel or require a hosted NetPro service.

```text
Browser → NetPro Web UI ──────→ PostgreSQL
             │                    ↑
             └→ NetPro API/server ─┘
                         migration job
```

The `server` service is the standalone `@netpro/server` process used by
`netpro serve`. The `web` service serves the Next.js UI and retains the
legacy/public card routes; the Observatory, Network, People, Search, Activity,
Import, and Scan surfaces use the standalone API.

The application image is a multi-stage Node 20 image. It contains the
production Next.js Web UI, the bundled `netpro` CLI used for migrations, both
migration trees, and the reference plugin/marketplace assets. PostgreSQL is a
separate service with a named volume.

## Start the stack

From a checkout or a release source tree:

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD to a long random value.
# Keep NETPRO_AUTH_MODE=local for loopback-only use.
docker compose build
docker compose up -d
```

The default host bindings are loopback-only:

```bash
curl http://127.0.0.1:3000/api/health  # Web UI process
curl http://127.0.0.1:3777/api/health  # standalone NetPro API/server
```

The database is not published to the host. The web container waits for both a
healthy PostgreSQL service and a successful one-shot migration service before
accepting traffic. `GET /api/health` is the container health check and reports
`"dialect":"postgresql"` when the stack is ready.

View logs and status:

```bash
docker compose ps
docker compose logs -f web
docker compose logs migrate
docker compose exec db pg_isready -U netpro -d netpro
```

## Configuration

`.env.example` is the complete reference. The minimum deployment setting is:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
```

Important settings:

| Variable                                            | Default                 | Purpose                                                              |
| --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                 | required                | Password for the private Postgres service                            |
| `APP_URL`                                           | `http://localhost:3000` | External origin used by optional OAuth/reverse proxy configuration   |
| `NETPRO_AUTH_MODE`                                  | `local`                 | `local`, `github`, or `open`; local is for loopback-only deployments |
| `NETPRO_WEB_PORT`                                   | `3000`                  | Host port for the Web UI                                             |
| `NETPRO_SERVER_PORT`                                | `3777`                  | Host port for the standalone NetPro API                              |
| `NEXT_PUBLIC_NETPRO_SERVER_URL`                     | `http://127.0.0.1:3777` | Browser-reachable API origin, baked into the UI build                |
| `NETPRO_SERVER_AUTH_MODE`                           | `open` on loopback      | API auth policy; use a protected mode before public exposure         |
| `NETPRO_AUTO_MIGRATE`                               | `false` in Compose      | Migrations are owned by the `migrate` service                        |
| `NETPRO_PLUGIN_DIR`                                 | `/data/plugins`         | Plugin directory, persisted in the `netpro_plugins` volume           |
| `HUNTER_API_KEY`, `PDL_API_KEY`, `CLEARBIT_API_KEY` | unset                   | Optional enrichment providers                                        |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`               | unset                   | Optional AI providers                                                |

Unset AI, enrichment, and OAuth variables do not prevent the application from
starting. PostgreSQL is the only database service in this Compose deployment;
local single-user installations should use `netpro init` and SQLite instead.

## Remote access and reverse proxies

The Compose default publishes port 3000 on `127.0.0.1`. Do not change it to a
public interface while leaving `NETPRO_AUTH_MODE=local`. For a remote server:

1. Set `NETPRO_AUTH_MODE=github`, or set `NETPRO_AUTH_MODE=open` only when a
   VPN/reverse proxy authenticates every request.
2. Set `APP_URL` to the final HTTPS origin.
3. Publish deliberately, for example `0.0.0.0:3000:3000` and
   `0.0.0.0:3777:3777`, or put Caddy, Nginx, or Traefik in front of the
   loopback bindings. Pass `NEXT_PUBLIC_NETPRO_SERVER_URL` at build time when
   the browser should use a different API origin.
4. Terminate TLS at the reverse proxy and forward SSE-compatible HTTP
   connections without buffering the event stream.

GitHub OAuth is optional for local use and is only required when the deployed
instance explicitly chooses `github` authentication. See
[deployment.md](deployment.md) for the provider callback and TLS details.

## Persistence and backups

The `postgres_data` named volume stores contacts, relationships, jobs-related
state, workspace data, and credentials encrypted by the application vault.
The `netpro_plugins` volume stores reviewed plugin installations across image
updates. Do not delete either volume during an upgrade.

A simple PostgreSQL backup is:

```bash
docker compose exec -T db pg_dump -U netpro -d netpro > netpro-$(date +%Y%m%d).sql
```

Restore into a stopped application stack (or a maintenance window):

```bash
docker compose stop web
cat netpro-20260911.sql | docker compose exec -T db psql -U netpro -d netpro
# Start the web service again; the migration job is idempotent.
docker compose up -d
```

For production, copy backups off the Docker host and test restores regularly.
The Compose volume is persistence, not a backup policy.

## Migrations and upgrades

Migrations are committed under `packages/db/migrations/sqlite` and
`packages/db/migrations/postgres`. The same `netpro migrate` command is used
by the Compose migration service and by operators:

```bash
docker compose run --rm migrate
# or, for a manually built image:
docker run --rm \
  --network <compose-network> \
  -e DB_DIALECT=postgresql \
  -e DATABASE_URL='postgresql://netpro:...@db:5432/netpro?sslmode=disable' \
  netpro:latest migrate
```

For an upgrade:

```bash
git pull
docker compose build
docker compose up -d
```

The migration service is a dependency of `web`, so a migration failure keeps
the application from starting instead of serving against a partial schema.
PostgreSQL migration execution uses an advisory lock, which also protects
operators who accidentally start two migration jobs at once.

## Image health and logs

The image has a Docker `HEALTHCHECK` against
`http://127.0.0.1:3000/api/health`. Compose uses bounded JSON log rotation for
the web, migration, and database services. Health checks are readiness
signals, not a replacement for backups, metrics, or external alerting.

The image runs as the unprivileged `netpro` user. Native SQLite support is
included for the bundled CLI even though the Compose runtime uses PostgreSQL;
this keeps the global CLI and Docker migration path on the same artifact.
