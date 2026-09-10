# Phase 3 — Local Database Architecture

**Generated:** 2026-09-10
**Branch:** `arena/01a08c0b-netpro`
**Follows:** [Phase 2](phase-2-serve.md)

## Objective

Make SQLite the default database for local installations, stored under
`~/.netpro/`, configurable via `config.toml`, with PostgreSQL as the
opt-in path for Docker/teams/remote deployments — and **no `DATABASE_URL`
requirement for local use**.

---

## What shipped

### Install directory (`packages/db/src/local.ts`)

The local layout the plan specifies lives in one module that both the CLI
and the server import (dependency-free — no native drivers, so the CLI
keychain can use it too):

```text
~/.netpro/               # NETPRO_HOME relocates everything
├── config.toml
├── netpro.db
├── logs/
└── keys/
```

Helpers: `netproHome()`, `configTomlPath()`, `defaultSqlitePath()`,
`ensureNetProHome()` (creates `home/logs/keys`), `ensureSqliteDir()`,
`expandHomePath()` (`~/` expansion), `resolveSqlitePath()` (relative config
paths resolve against the install directory, not the process cwd).

`NETPRO_HOME` now also relocates the CLI's encrypted keychain
(`credentials.enc`), so secrets move with the install.

### `config.toml` support

`parseToml()` implements the documented subset — sections, basic/literal
strings, integers, floats, booleans, comments — and rejects everything else
(inline tables, arrays, dotted keys, duplicates, bare words) with a
line-numbered error. `readLocalConfig()` validates `[database]` and
`[server]`, rejects unknown sections, and names the offending file in every
error. A typo fails loudly; it is never silently ignored.

The default file written by `netpro init` is all commented no-ops, so
"fresh install" and "defaults" are the same thing.

### Database resolution

`resolveDatabaseConfig(env)` is the single decision point:

| Setting | Precedence (highest wins) |
|---------|---------------------------|
| dialect | `DB_DIALECT` env → config `[database].dialect` → Vercel+`DATABASE_URL` inference (legacy, removed in Phase 4) → **sqlite** |
| sqlite path | `DB_PATH` env → config `[database].path` → **`<home>/netpro.db`** |
| postgres URL | `DATABASE_URL` env → config `[database].url` → **error with local-first advice** |

`createDb(env)` now: resolves through the above, creates the SQLite file's
parent directory (a fresh `~/.netpro` needs no ceremony), keeps the WAL +
busy-timeout + foreign-keys pragmas, and keeps the "no SQLite on Vercel"
guard rail verbatim. `describeConn()` renders a display-safe location
(`~/`-abbreviated paths, redacted Postgres URLs) for banners and `status`.

`resolveDialect()` keeps its old signature and semantics for existing
callers (web instrumentation, tests) — it delegates to the shared resolver.

### `netpro init`

The stub is gone. `executeInit()`:

1. creates `<home>/`, `logs/`, `keys/` (idempotent);
2. writes `config.toml` **only if missing** (never overwrites edits);
3. opens the configured database and applies migrations explicitly
   (`runMigrations(conn, { force: true })`, same runner as `netpro migrate`,
   including the Postgres advisory lock);
4. prints the summary and next steps; failures print an actionable hint
   (e.g. postgres selected without a URL → "keep the default sqlite
   dialect — it needs nothing").

---

## Exit criteria

| Criterion | Status |
|-----------|--------|
| Fresh install works with `netpro init` + `netpro serve` | ✅ smoke-tested with an empty environment (no `DATABASE_URL`, no `DB_*`, no Postgres) |
| SQLite default at `~/.netpro/netpro.db` | ✅ default path + directory auto-create + `~` display |
| PostgreSQL optional | ✅ `[database] dialect/url` or env; pooled, TLS semantics and advisory-lock migrations unchanged |
| `DATABASE_URL` not required locally | ✅ pinned by tests — a *set* `DATABASE_URL` does not flip the dialect |
| Suggested directory layout | ✅ `config.toml`, `netpro.db`, `logs/`, `keys/` |

## Tests added

- `packages/db/src/local.test.ts` — 35 tests: install dir, `~/` expansion,
  TOML subset + error lines, config precedence matrix, Vercel inference,
  URL redaction.
- `packages/db/src/config.test.ts` — createDb guard rails updated to the
  unified dialect error; all original behaviours preserved.
- `apps/cli/src/commands/init.test.ts` — layout + migrated schema on disk,
  idempotence, config preservation, postgres-without-URL hint, written
  config parses back to documented defaults.
- `packages/server/src/serve.test.ts` — `runServe` fails loudly on a
  postgres-dialect config with no URL (never half-starts).
