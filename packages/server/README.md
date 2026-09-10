# `@netpro/server`

Standalone HTTP server for local-first NetPro.

This package is the application backend. The Web UI (`apps/web`) is a client.

## Phase 1 scope

- Builds independently via `tsup`
- Imports `@netpro/core` and `@netpro/db` for domain work and persistence
- Does **not** depend on Vercel APIs, `next`, or `apps/web`
- Default bind: `127.0.0.1:3777` (remote bind is opt-in)
- Ships `GET /api/health` and scaffold modules for auth, jobs, and SSE events

Later phases expand routes, jobs, SSE, and `netpro serve`.

## Layout

```text
packages/server/
├── src/
│   ├── index.ts        # public exports + CLI entry
│   ├── app.ts          # composition root
│   ├── config.ts       # host/port/autoMigrate
│   ├── server.ts       # listen / shutdown
│   ├── routes/         # HTTP handlers (orchestrate core)
│   ├── middleware/     # request-id, JSON helpers
│   ├── jobs/           # job registry scaffold (Phase 7)
│   ├── events/         # event bus scaffold (Phase 8)
│   └── auth/           # local trust scaffold (Phase 5)
└── package.json
```

## Scripts

```bash
npm run build -w @netpro/server
npm run typecheck -w @netpro/server
npm run test -w @netpro/server
npm run dev -w @netpro/server
```

## Programmatic use

```ts
import { createApp, startServer } from '@netpro/server';

const app = await createApp();
const running = await startServer(app);
console.log(running.url); // http://127.0.0.1:3777
```

## Dependency rule

```text
@netpro/core
     ↓
@netpro/server   ← HTTP / auth / jobs / SSE
     ↓
apps/web         ← visualization only (future)
```

Business rules stay in `@netpro/core`. Routes orchestrate; they do not reimplement search, graph, or import.
