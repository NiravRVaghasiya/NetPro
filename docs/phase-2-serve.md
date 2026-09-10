# Phase 2 — Implement `netpro serve`

**Generated:** 2026-09-10
**Branch:** `arena/01a08c0b-netpro`
**Follows:** [Phase 0 baseline](phase-0-baseline.md) (includes the Phase 1 completion note)

## Objective

Make NetPro runnable entirely on the user's machine: `netpro serve` starts
the application server locally — default bind `127.0.0.1:3777` — with no
Vercel, no cloud infrastructure, and no GitHub OAuth.

---

## What shipped

### `netpro serve` (apps/cli)

`apps/cli/src/commands/serve.ts` registers `netpro serve --host --port`.
The command is a thin client of `@netpro/server`: it imports `runServe()`
dynamically (so `--help` and non-server commands never load the HTTP/DB
stack) and blocks until the server stops.

Resolution order for host/port — flags → `NETPRO_HOST`/`NETPRO_PORT` env →
`~/.netpro/config.toml` `[server]` → `127.0.0.1:3777`.

### `runServe()` (packages/server)

`packages/server/src/serve.ts` is the composition point: load config →
create app (migrations per `NETPRO_AUTO_MIGRATE`) → bind → print the
plan's banner:

```text
NetPro server started

Local:    http://127.0.0.1:3777
Database: ~/.netpro/netpro.db

Web UI:   http://127.0.0.1:3777
```

Behaviour details:

- **Loopback-only default.** Non-loopback binds print an explicit warning;
  `0.0.0.0`/`::` binds advertise the browsable loopback URL instead of the
  wildcard. Never a silent network exposure.
- **Actionable listen errors.** `EADDRINUSE` → "Port 3777 is already in
  use…"; `EACCES` and `EADDRNOTAVAIL` get their own hints.
- **Graceful shutdown** on SIGINT/SIGTERM (`stopped` promise resolves with
  the stop reason); the DB pool is closed with the server.
- **Built-in console page** at `GET /` (dependency-free HTML, live health
  via `fetch('/api/health')`) so the promised "Web UI" URL shows something
  real before the full Observatory UI phase. JSON service identity moved to
  `GET /api/server-info`.
- The standalone `netpro-server` bin now lives in `src/bin.ts`. Keeping the
  executable entry separate from `src/index.ts` matters because the CLI
  *bundles* `@netpro/server` (tsup `noExternal: @netpro/*`): the Phase 1
  argv-sniffing auto-run heuristic could have started a server as an import
  side effect of the CLI binary.

### `netpro status` (apps/cli)

`apps/cli/src/commands/status.ts` — the CLI↔server communication the plan
asks for: install dir, config presence, database dialect/location/migration
state, and a 1.5 s-timeout probe of `GET /api/health` (URL from
`NETPRO_URL`, else the same host/port resolution `serve` uses; `--json` for
scripts). Status is read-only and never crashes: a broken `config.toml`
surfaces as a status line with the parser's file-and-line error.

### `netpro init` (apps/cli)

Replaced the `not yet implemented` stub — it now creates the Phase 3 local
install (see [phase-3-local-database.md](phase-3-local-database.md)).

---

## Exit criteria

| Criterion | Status |
|-----------|--------|
| `netpro serve` starts without Vercel / cloud / GitHub OAuth | ✅ smoke-tested: `init` → `serve` → `/api/health` → `status`, zero env vars |
| Default bind `127.0.0.1:3777` | ✅ `loadConfig` defaults + `isLoopbackHost` guard + warning on non-loopback |
| CLI can start and communicate with the local server | ✅ `netpro serve`, `netpro status` (health probe), `netpro init` |
| Banner matches the plan | ✅ pinned by `serve.test.ts` |

## Tests added

- `packages/server/src/serve.test.ts` — banner, loopback default, wildcard
  warning, EADDRINUSE mapping, config-error propagation, `isLoopbackHost`,
  `friendlyListenError`.
- `packages/server/src/config.test.ts` — `[server]` from config.toml,
  env > file precedence (per key), loud invalid-config failure.
- `apps/cli/src/commands/serve.test.ts` — end-to-end flag→server→health→
  signal-shutdown through `executeServe`.
- `apps/cli/src/commands/status.test.ts` — fresh install, live probe,
  `NETPRO_URL`, invalid-config resilience.
- `apps/cli/src/cli.test.ts` — command list pinned to 23 (adds `serve`,
  `status`).
