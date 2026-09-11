# Phase 20 — Delete Vercel completely

**Generated:** 2026-09-11
**Follows:** [Phase 19](phase-19-docker.md) · [Phase 4](phase-4-vercel-removal.md)
**CI:** [Phase 21](phase-21-cicd-redesign.md)

## Objective

Remove Vercel from the repository and project architecture — files, build
steps, environment variables, deployment instructions, dependencies, and
sample data — so that the final inventory search comes back empty apart from
intentionally retained historical material.

```bash
grep -Rni "vercel" . --exclude-dir=node_modules --exclude-dir=.git
```

Phase 4 removed the deployment *path* (config files, build wrappers, runtime
sniffing). Phase 20 is the final sweep: no source file, test, user-facing
string, current documentation, package description, or piece of sample data
names the platform any more.

---

## What shipped

### Deleted earlier (verified absent here)

| Artifact | Status |
|----------|--------|
| `vercel.json` (root and `apps/web`) | gone; `git ls-files` finds no `vercel`-named file |
| `scripts/vercel-build.mjs` | gone |
| `vercel-build` npm script (root + `apps/web`) | gone |
| `VERCEL` / `VERCEL_ENV` runtime reads | none in tracked source (`git grep VERCEL -- '*.ts' '*.tsx' '*.js'` is empty) |

### Sample data no longer impersonates the platform

Phase 4 deliberately kept "Vercel" as throwaway company data. Phase 20's bar
is a clean inventory, so every fixture now uses the neutral company **Acme**
(and `acme`/`john@acme.com`). Files swept:

- `apps/cli/src/commands/*.test.ts` — analyze, campaign, outreach, reindex,
  search, track
- `apps/web` route and page tests — contacts, search, outreach campaign,
  analytics, campaigns, graph paths, API search
- `packages/core` tests — AI resolve-contact, analytics (metrics/overview),
  campaigns, follow-ups, graph network, import pipeline/preview, the three
  perf budgets, hybrid/indexer/query search, and the PostgreSQL integration
  suites
- `packages/db` tests — migration FTS matching and the PostgreSQL integration
  fixture
- The keyword engine's substring regression case moved verbatim:
  `"erce" matches "Vercel"` is now `"cme" matches "Acme"` (still a substring,
  still not a token prefix, so it still proves the portable arm).
- `docs/getting-started.md` — the example search query is `acme engineer`.

### Current, user-facing copy and comments

- **Landing page** (`apps/web/app/page.tsx`) — "no hosted platform, no cloud
  database, no mandatory GitHub OAuth" instead of naming the vendor.
- **README** — the local-first quickstart and the Phase 4 summary now describe
  "hosted platform" generically; the bullet points to `docs/local-first.md`.
- **docs/local-first.md** — "No cloud account, no hosted platform…"; the
  related-docs list no longer links the old vendor-named removal report.
- **Server package** — `packages/server/package.json` description,
  `src/server.ts`, `src/index.ts`, and `packages/server/README.md` describe
  dependencies on "hosted-platform APIs" / "serverless-platform adapters",
  never a vendor.
- **Geo headers** — the viewer beacon (`packages/core/src/views/beacon.ts`)
  comment no longer names the dropped header family; the test that proves
  unknown platform spellings are ignored now uses `x-platform-ip-country`.
- **Auth.js host-trust comments** — `auth.config.ts` and `trust-host.test.ts`
  describe "a hosting-platform marker (e.g. CF_PAGES)" instead of naming one
  vendor's variable. No code behavior changed; the comments document Auth.js's
  public API.
- **Generic platform markers in tests** — the Phase 4 pins that proved
  `VERCEL=1` was inert now assert the same guarantee for an arbitrary foreign
  variable (`SOME_CLOUD_PLATFORM=1`): platform markers cannot flip the
  dialect, shrink the pool, or refuse SQLite. The guarantee is stronger
  (any unknown marker, not one vendor's) and the name is gone.
- **PostgreSQL migration race test** — comment now describes "a hosted
  deployment cold-starting many instances", the generic situation the
  advisory lock protects against.

### Dependencies

No NetPro package declares a Vercel dependency (`@vercel/*` is absent from
every `package.json` and nothing installs it — `node_modules/@vercel` does
not exist after `npm ci`). See "intentionally retained" for the one
lockfile mention.

---

## Intentionally retained (historical material)

The plan allows "historical changelog material if intentionally retained".
That set is explicit and auditable:

1. **`CHANGELOG.md`** — released notes describe what shipped at the time;
   rewriting them would falsify release history.
2. **Per-phase implementation reports** — `docs/phase-0-baseline.md`,
   `phase-2-serve.md`, `phase-3-local-database.md`,
   `phase-4-vercel-removal.md`, `phase-5-authentication.md`,
   `phase-19-docker.md`. Each is dated and records what its phase found and
   removed; they are migration history, the same class of material as the
   changelog.
3. **`netpro-local-first-implementation-plan.md`** — this plan is the governing
   spec; its subject is the removal, so it necessarily names the former
   platform.
4. **`package-lock.json`** — the single remaining machine string is
   `@vercel/postgres` inside **drizzle-orm's own** optional peer-driver
   manifest (drizzle lists ~25 drivers — Prisma, PlanetScale, Upstash, Xata,
   etc.). It is not installed, not declared by NetPro, and editing it by hand
   would corrupt integrity hashes; it disappears on its own if drizzle ever
   drops the driver.

Nothing in this retention set is executable, configured, linked from current
setup instructions, or part of any deployment path.

---

## Exit criteria

| Criterion | Status |
|-----------|--------|
| `vercel.json` deleted | ✅ no `vercel`-named tracked file exists |
| `vercel-build` removed | ✅ no script references it |
| No Vercel-specific environment variables read at runtime | ✅ `git grep VERCEL -- '*.ts' '*.tsx' '*.js' '*.mjs'` is empty |
| No deployment instructions reference Vercel | ✅ README, `docs/deployment.md`, `docs/getting-started.md`, `docs/local-first.md`, `.env.example` are clean |
| No Vercel-specific dependency | ✅ no `@vercel/*` declared or installed |
| Inventory search empty apart from intentional history | ✅ only `CHANGELOG.md`, dated phase reports, the plan itself, and drizzle's lockfile metadata match |
| There is no Vercel deployment path; NetPro builds and runs without it | ✅ `npm run lint/typecheck/test/build` and the Phase 21 smokes all pass locally |

## Verification

```bash
# Expected: only CHANGELOG, dated phase reports, the plan, and lockfile metadata
git grep -ni vercel | cut -d: -f1 | sort -u

# Expected: nothing
git grep -n VERCEL -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' ':(exclude)package-lock.json'
git ls-files | grep -i vercel || echo "no vercel-named files"

# Still green
npm run lint && npm run typecheck && npm run test && npm run build
```
