# Phase 14 — Scan Visualization

**Branch:** `arena/01a08cdb-netpro`
**Follows:** [Phase 13 — Pathfinder](phase-13-pathfinder.md)

## Objective

Make scanning understandable. A scan is one observable sweep — reindex +
enrichment + graph analysis — and the Web UI renders it as:

```text
SCAN
────────────────────────
Source
LinkedIn CSV / configured source

Progress
████████████████░░░░ 82%

Processed
3,942 / 4,821

New contacts
128

Updated contacts
391

Relationships discovered
2,103

Enrichment
████████████████░░░░░ 61%
```

Activity updates through SSE.

---

## What shipped

### Server (`packages/server/src/routes/scan.ts`)

`POST /api/scan` now performs real work instead of emulating progress. The
route orchestrates only — every step is a `@netpro/core` call, and each is
best-effort so a scan without providers (or without the search-index
migration) still completes (Phase 17: external providers are optional):

1. **Reindex** — `reindexSearchIndex` (offline). `result.index` carries
   `scanned` / `indexed` / `skipped` / `pruned` / `keywordIndexAvailable`.
2. **Enrichment** — `EnrichmentPipeline.enrichBatch` on a bounded batch when
   Hunter/PDL/Clearbit keys are present; otherwise a zero-enrichment skip.
3. **Graph** — `getNetworkGraph` for confirmed edges, pending candidates,
   and Louvain communities.

The job's `metadata.result` snapshot mirrors the Phase 14 mockup verbatim:
`source`, `processed`, `total`, `newContacts`, `updatedContacts`,
`relationships`, `relationshipsDiscovered`, `communities`, `enrichment`
(`configured` / `enriched` / `progress` / `skipped` / `error`), and `index`.
The SSE ladder publishes `scan.started` → `scan.progress` (15/40/70/90) →
`enrichment.*` → `scan.completed`, plus `graph.updated`,
`relationship.discovered`, and `contact.updated` when the work found
something. `GET /api/scan/:id` returns the same snapshot.

### Web UI (`apps/web/app/(app)/scan/page.tsx` + `components/scan-panel.tsx`)

New first-class page in the primary nav (Observatory · Network · Search ·
Pathfinder · People · Activity · **Scan** · Settings), server-fetched and
SSE-live:

- **`/scan`** reads the most recent scan job (`GET /api/jobs?type=scan`) and
  provider status (`GET /api/providers`) so the view is meaningful before the
  SSE connects, then hands off to `<ScanPanel>`.
- **`<ScanPanel>`** renders the mockup — Source, Progress bar, Processed X/Y,
  New contacts, Updated contacts, Relationships discovered, Enrichment (its
  own progress strip), plus the index summary — and offers a "Start scan"
  button that `POST /api/scan`. Progress updates live via
  `useNetProEvents` (scan/enrichment/job events), so a terminal
  `netpro scan` appears here without a refresh.
- An `ActivityFeed` filtered to scan/enrichment/graph/job events sits below
  the panel, and `/scan` is registered in `proxy.ts`'s protected routes.

## Exit criteria (plan)

- [x] A dedicated Scan view shows Source, Progress, Processed, New contacts,
      Updated contacts, Relationships discovered, and Enrichment.
- [x] Scan progress and results stream over SSE (`scan.progress`,
      `enrichment.*`, `graph.updated`).
- [x] The scan job carries real metrics computed by `@netpro/core` — the Web
      UI visualizes, it does not compute.

## Tests

- `packages/server/src/api.test.ts` — `POST /api/scan` returns a completed
  job whose `result` snapshot is populated from a seeded contact + confirmed
  edge (`processed`, `total`, `relationships`, `index`, `enrichment`), and
  `GET /api/scan/:id` echoes it.
- `apps/web/app/(app)/scan/page.test.tsx` — snapshot render (metrics),
  empty state, and server-unreachable banner.
