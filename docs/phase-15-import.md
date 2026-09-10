# Phase 15 — Import Experience

**Branch:** `arena/01a08cdb-netpro`
**Follows:** [Phase 14 — Scan Visualization](phase-14-scan.md)

## Objective

Move imports from a CLI-only experience to a unified workflow:

```text
CLI:
netpro import linkedin.csv

Web:
Upload → Preview → Validate → Import
```

The Web UI triggers a server job, the same import logic serves CLI and Web
UI, and there is no duplicate importer.

---

## What shipped

### Core (`packages/core/src/import/preview.ts`)

`analyzeImportRow` is the single normalization + validation path, now shared
by the real import and the preview: `runImport` (pipeline.ts) and the new
`previewImport` both call it, so a row the preview flags is exactly a row the
import will skip. `previewImport(csv, { limit, maxIssues })` parses the CSV,
reports columns, total/valid/invalid row counts, per-row issues (capped),
and a bounded preview table of normalized contacts — **without writing to the
database**. `runImport` was refactored onto `analyzeImportRow` (behavior
preserved; all pipeline tests unchanged).

### Server (`packages/server/src/routes/import.ts`, `routes/index.ts`)

`POST /api/import/preview` runs `previewImport` for the Web UI's Preview and
Validate steps. `POST /api/import` is unchanged in shape — it still wraps
`runImport` in a Job and streams `import.*` / `job.*` events. Exactly one
importer (`@netpro/core/src/import`); the server routes only orchestrate.

### CLI (`apps/cli/src/commands/import.ts`)

`netpro import linkedin.csv` is now the canonical invocation (positional
`[file]`), with `--linkedin <path>` kept for backwards compatibility, and
`netpro import --preview linkedin.csv` printing the same preview/validate the
Web UI shows before anything is imported.

### Web UI (`apps/web/app/(app)/import/page.tsx`)

The `/import` page is rebuilt as the four-step flow, and it is a client of
the NetPro server (no import logic in React, no direct database):

1. **Upload** — drag-and-drop or browse a LinkedIn connections CSV.
2. **Preview** — `POST /api/import/preview` → columns, row counts, and a
   normalized preview table.
3. **Validate** — the preview's per-row issues (the rows that will be
   skipped) render as a warning list.
4. **Import** — `POST /api/import` → a server Job, with live progress over
   SSE (`useNetProEvents` scoped to the job) and the final summary
   (imported / merged / relationship candidates / skipped) with links into
   the Observatory and Activity.

The legacy Next.js `/api/import` route remains as a compatibility path until
Phase 24 removes the old Web architecture; the new page does not use it.

## Exit criteria (plan)

- [x] `netpro import linkedin.csv` imports from the terminal.
- [x] The Web UI offers Upload → Preview → Validate → Import.
- [x] The Web UI import triggers a server Job (with SSE progress).
- [x] CLI and Web UI share one importer — `runImport` / `previewImport` in
      `@netpro/core`, never a React reimplementation.

## Tests

- `packages/core/src/import/preview.test.ts` — preview parsing/validation,
  column detection, bounding, preamble handling, and `analyzeImportRow`
  parity with `runImport`.
- `packages/server/src/api.test.ts` — `POST /api/import/preview` validates
  without writing; missing-CSV 400.
- `apps/cli/src/commands/import.test.ts` — positional file, positional-vs-
  `--linkedin`, preview output, and missing-path errors.
- `apps/web/app/(app)/import/page.test.tsx` — renders the four-step flow.
