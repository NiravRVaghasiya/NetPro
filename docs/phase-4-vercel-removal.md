# Phase 4 — Remove Vercel-Specific Assumptions

**Generated:** 2026-09-10
**Branch:** `arena/01a08c45-netpro`
**Follows:** [Phase 3](phase-3-local-database.md)

## Objective

Replace Vercel deployment assumptions with generic Node execution:

```text
vercel.json · VERCEL · VERCEL_ENV · Vercel-specific runtime behavior
Vercel deployment URLs · Vercel build commands · Vercel serverless functions
Vercel-specific filesystem assumptions
```

Exit criterion: a clean checkout builds with standard Node/npm/Turborepo
commands — `npm run build`, `npm run test`, `npm run lint`,
`npm run typecheck` — and `npm run vercel-build` does not exist to require.

---

## What shipped

### Deleted

| Path | Why it existed |
|------|----------------|
| `vercel.json` | Vercel-only build command, function config, headers, cron wiring |
| `scripts/vercel-build.mjs` | Migrate-then-build wrapper Vercel ran (`vercel-build`) |
| `vercel-build` script (root + `apps/web`) | The deploy step `vercel.json` invoked |

There is no replacement build command: `npm run build` is the deploy path
everywhere. Migrations remain an explicit step (`netpro migrate` /
`npm run db:migrate`) for Docker and long-lived servers, and the Dockerfile's
compose stack already ran exactly that.

### Database dialect is configured, never inferred

`packages/db/src/local.ts` dropped the last inference — a `DATABASE_URL` on a
Vercel host used to flip the dialect to postgresql. Precedence is now:

| Setting | Precedence (highest wins) |
|---------|---------------------------|
| dialect | `DB_DIALECT` env → `[database] dialect` → **sqlite** |
| sqlite path | `DB_PATH` env → `[database] path` → **`<home>/netpro.db`** |
| postgres URL | `DATABASE_URL` env → `[database] url` → error with local-first advice |

`resolveDialectStep()`'s `source` is therefore `'env' | 'config' | 'default'`
(the `'inferred'` member is gone), and a *set* `DATABASE_URL` no longer changes
what local NetPro runs on.

### Serverless is stated, not sniffed

`packages/db/src/index.ts`:

- `isServerlessRuntime(env)` replaces the platform sniff. It is `true` when
  `NETPRO_SERVERLESS` is set to anything but `0/false/no/off`, or when a
  function runtime sets `AWS_LAMBDA_FUNCTION_NAME`/`FUNCTION_TARGET`;
  otherwise `false` (a long-lived server — the local-first default).
- `resolvePoolConfig()` uses that switch: pool `max` 1 (idle 10 s) for
  serverless, 10 (idle 30 s) otherwise, both overridable with
  `NETPRO_DB_POOL_MAX` / `NETPRO_DB_POOL_IDLE_MS`.
- `createDb()`'s "refuse SQLite on Vercel" guard rail is gone, along with its
  `NETPRO_ALLOW_EPHEMERAL_SQLITE` opt-out. Whether SQLite is appropriate is the
  operator's call — the docs answer it (it needs a persistent filesystem)
  instead of the process guessing from variables NetPro does not own.

### Runtime commentary and platform headers

- `packages/db/src/migrate.ts`, `apps/cli/src/commands/migrate.ts`,
  `apps/web/instrumentation.ts`: concurrent-start migration wording is now
  about "many instances starting at once" and the Postgres advisory lock, not
  about one platform's cold starts.
- `packages/core/src/views/beacon.ts`: viewer geolocation reads generic proxy
  headers `x-geo-country` / `x-geo-city` (Cloudflare's `cf-ipcountry` /
  `cf-ipcity` are accepted spellings). `x-vercel-ip-*` is no longer read, and
  NetPro still never performs a lookup itself.
- `apps/web/next.config.ts`, `apps/web/lib/trust-host.ts`: comments explain the
  Auth.js v5 host-trust rule (`AUTH_URL`/`AUTH_TRUST_HOST`, not
  `NEXTAUTH_URL`) without the platform anecdote. Behaviour is unchanged — the
  variable *names* are part of Auth.js's public API, not Vercel's.
- CI's Node-matrix comment no longer claims Vercel runs Node 22.

### Deployment artifacts are generic

`docker-compose.yml`, `.env.example`, and `apps/web/.env.example` describe the
two real targets — this machine, and a server you run — with the Docker path
as the self-hosted default. Pool sizing, migrations, and the `AUTH_URL` rule
are documented in those terms.

---

## What deliberately stayed

- **`CHANGELOG.md` history.** Released notes describe what shipped at the time;
  rewriting history to hide a former deployment target would be dishonest.
- **Auth.js's `AUTH_URL` / `AUTH_TRUST_HOST` / `NEXTAUTH_URL` variables.** They
  belong to Auth.js, not to a host — and Phase 5 makes them optional rather
  than required.
- **Sample data.** Test fixtures and demos that use "Vercel" as a company name
  (a person's import, search documents) are data, not an assumption about
  where the code runs.

---

## Exit criteria

| Criterion | Status |
|-----------|--------|
| No `vercel.json`, no `npm run vercel-build` | ✅ both deleted (root and `apps/web`); nothing references them |
| `VERCEL`/`VERCEL_ENV` never read at runtime | ✅ pinned by `packages/db/src/{index,local}.test.ts` — `VERCEL=1` changes neither dialect nor pool |
| No platform-specific runtime behavior | ✅ `NETPRO_SERVERLESS`/`NETPRO_DB_POOL_MAX` replace the sniff; migrations are generic |
| No Vercel filesystem assumptions | ✅ SQLite is allowed anywhere and documented as needing persistence |
| Standard build/test path | ✅ `npm run build` / `test` / `lint` / `typecheck` (Turborepo) — see the Phase-4 verification below |

## Tests changed or added

- `packages/db/src/config.test.ts` — pooling tests now drive
  `NETPRO_SERVERLESS`/`FUNCTION_TARGET`; `VERCEL=1` is asserted *not* to change
  the pool, and SQLite opens wherever it is configured instead of throwing.
- `packages/db/src/local.test.ts` — the "infers postgresql on Vercel" case is
  replaced by "never infers postgresql from `DATABASE_URL` alone (phase 4)",
  and `source` is asserted to be `'default'`.
- `packages/core/src/views/beacon.test.ts` — geo assertions use
  `x-geo-country`/`x-geo-city`, and `x-vercel-ip-*` is proved to be ignored.
- `.github/workflows/ci.yml` — the docker job starts the production image with
  no auth credentials at all (Phase 5's exit criterion) and the owner-only API
  assertions are made from a remote-shaped request.
