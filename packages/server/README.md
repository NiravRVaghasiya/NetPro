# `@netpro/server`

Standalone HTTP server for local-first NetPro.

This package is the application backend. The Web UI (`apps/web`) is a client.

## Scope

- Builds independently via `tsup`
- Imports `@netpro/core` and `@netpro/db` for domain work and persistence
- Does **not** depend on Vercel APIs, `next`, or `apps/web`
- Default bind: `127.0.0.1:3777` (remote bind is opt-in and warns)
- Ships `GET /api/health`, the built-in console page at `/`, and scaffold
  modules for auth, jobs, and SSE events
- **Phase 2:** `runServe()` powers `netpro serve` — banner, loopback-only
  defaults, actionable listen errors, graceful SIGINT/SIGTERM shutdown
- **Phase 3:** server settings and the database resolve through
  `~/.netpro/config.toml` + `NETPRO_*` env (see `docs/local-first.md`)

Later phases expand routes (Phase 6), jobs (Phase 7), and SSE (Phase 8).

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
│   ├── routes/         # HTTP handlers (orchestrate core)
│   ├── middleware/     # request-id, JSON helpers
│   ├── jobs/           # job registry scaffold (Phase 7)
│   ├── events/         # event bus scaffold (Phase 8)
│   └── auth/           # local trust scaffold (Phase 5)
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
