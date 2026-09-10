# Phase 16 — CLI ↔ Web UI Integration

**Branch:** `arena/01a08cf4-netpro`
**Follows:** [Phase 15 — Import Experience](phase-15-import.md)

## Objective

Ensure both interfaces are clients of the same system:

```bash
netpro scan
```

The UI immediately shows:

```text
Scan started
```

Then:

```text
23%
41%
68%
100%
```

Likewise, starting a scan from the UI produces the same backend job the CLI
uses.

## Rule

One operation:

```text
One core implementation
One job system
One event stream
Multiple interfaces
```

---

## What shipped

### The gap this phase closes

Before Phase 16 the scan pipeline lived _inside_ the server route
(`packages/server/src/routes/scan.ts`). That made the Web UI's scan the only
scan: `netpro scan` did not exist, even though the Scan view already told users
to "run `netpro scan` in a terminal — it appears here live", and the CLI's job
helpers already promised "a `netpro scan` triggered from the CLI and a scan
triggered from the Web UI look identical to the event stream". The promise was
real; the command was not.

### Core (`packages/core/src/scan/index.ts`)

`runScan(conn, options)` is now **the one scan implementation** — reindex →
(optional) enrichment → graph analysis — moved out of the HTTP layer:

- `ScanResult` is the result snapshot (source, processed/total, newContacts,
  updatedContacts, relationships, relationshipsDiscovered, communities,
  `enrichment`, `index`, `graph`, and a `providers` status snapshot).
- `onProgress(update)` emits `{ stage, progress, message }` for every stage
  transition: `queued` 0 → `discovering` 15 → `processing` 40 → 70 →
  `enriching` (70/90) → `indexing` 90 → `completed` 100.
- Every step is best-effort by design. An unmigrated database, a missing FTS
  table, or **zero configured providers** still produces a completed scan with
  honest numbers — Phase 17's rule applied at the core.

### Server (`packages/server/src/routes/scan.ts`)

The route now **orchestrates only**: create the job, run `runScan`, and map
each core stage transition to one job update plus one SSE event
(`scan.progress`, with `stage`, `source`, and `origin`). It no longer reindexes,
enriches, or analyses anything itself.

`POST /api/scan` accepts `{ source, origin }`, where `origin` is `web` (default)
or `cli`, and records it on `job.metadata.origin` so the UI can say where a scan
came from. `GET /api/jobs?type=scan` and `GET /api/scan/:id` are unchanged.

### CLI (`apps/cli/src/commands/scan.ts`)

`netpro scan` is a real command, with two modes and one outcome:

| Mode     | When                                          | What happens                                                                                                                                                                      |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server` | a NetPro server is reachable (`netpro serve`) | `POST /api/scan` with `origin: "cli"` — **the same server job the Web UI renders** — then reads that job's events back off `GET /api/events/stream?jobId=…` and prints the ladder |
| `local`  | no server running (or `--local`)              | runs `runScan` in-process, wrapped in the shared job model, and mirrors its events to the server if one appears                                                                   |

```text
$ netpro scan
Scan started on the NetPro server (http://127.0.0.1:3777) — job 3f2a9c11
The Web UI is watching this same job: http://127.0.0.1:3777
    0% Scan queued
   15% Discovering contacts
   40% Processing contacts
   70% Indexed 128 contact(s)
   70% Enrichment skipped — no provider configured
   90% Analyzing graph
  100% Scan complete
Scan complete
  Source: linkedin_csv
  Processed 128 / 128 · New 128 · Updated 0 · Relationships 2103 · Communities 12
  Index: 128 scanned, 128 written, 0 unchanged · FTS available
  Enrichment: not configured — skipped (NetPro scanned everything offline)
```

Flags: `--source <name>`, `--no-enrich`, `--local`, `--server <url>`, `--json`.
A server that answers the health probe but cannot run a scan falls back to the
in-process sweep rather than failing the command.

### CLI job + event plumbing (`apps/cli/src/lib/jobs.ts`)

`runCliJob({ type, metadata, run })` wraps a core operation in the _server's_
job model (`createJobRegistry` / `createEventBus` from `@netpro/server`) and
gives the operation an emitter:

- `update(progress, message, patch)` → `job.progress` + registry progress
- `publish(event)` → domain events (`scan.started`, `import.completed`, …)

Both go to the local bus **and**, best-effort, to `POST /api/events/ingest` on a
running server, so the Web UI's Activity feed shows a terminal operation as it
happens. Forwarding is fire-and-forget and disables itself after one failure, so
a missing server costs nothing. `netpro import` now runs through the same path
(`import.started` → `import.progress` → `import.completed`), which is why a
terminal import is visible in Activity while it runs.

### Web UI (`apps/web/components/scan-panel.tsx`, `app/(app)/scan/page.tsx`)

- The panel posts `origin: "web"` and badges whichever interface started the
  job: **"started in a terminal — netpro scan"** vs **"started here"** — proof,
  in the UI, that both clients produce the same job.
- `/scan` renders provider status alongside the sweep (Phase 17), so "why is
  enrichment 0?" is answered in place.

## Exit criteria (plan)

- [x] `netpro scan` runs from the terminal and the UI shows "Scan started" —
      the CLI delegates to the same server job, so the UI shows it live; when no
      server is running the CLI runs the identical core sweep and mirrors its
      events into the same stream.
- [x] Starting a scan from the UI produces the same backend job the CLI uses —
      one route (`POST /api/scan`), one core function (`runScan`), one job model,
      one event stream; only `metadata.origin` differs.
- [x] Progress flows as the plan's ladder (23% → 41% → 68% → 100%): core emits
      stage transitions, the server publishes them as `scan.progress` over SSE,
      and the CLI replays them from `GET /api/events/stream?jobId=…`.

## Tests

- `packages/core/src/scan/index.test.ts` — the sweep on an empty and a seeded
  database, the full monotonic progress ladder, source handling, `--no-enrich`
  semantics, and the unmigrated-database degradation path.
- `apps/cli/src/commands/scan.test.ts` — in-process run and narrative output,
  `scan.*` events in the shared job model, delegation (POST body carries
  `origin: "cli"`, then the SSE replay is parsed), `--local`, and the fallback
  when the server cannot run a scan.
- `packages/server/src/api.test.ts` — `POST /api/scan` records `origin`
  (`web` vs `cli`) with identical snapshots and both jobs listable, and the SSE
  stream carries the `scan.started` / `scan.progress` / `scan.completed` ladder
  including `"origin":"cli"`.
- `apps/web/app/(app)/scan/page.test.tsx` — the origin badge for a
  CLI-started scan, plus provider status on the scan page.
