# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

**v1.0 Phase 1 (Import, Enrichment & Export) is implemented** on top of the
v0.1-alpha scaffold: LinkedIn CSV import with dedup/merge, three-provider
contact enrichment (Hunter.io, People Data Labs, Clearbit), and CSV export —
wired into both the CLI and the web app. The full monorepo (CLI + web,
dual-dialect Drizzle database, GitHub OAuth via Auth.js) builds, lints,
typechecks, and tests cleanly. Remaining v1.0 features — people search,
network analytics, AI outreach, profile card — are still stubs; each becomes
its own future spec built on this foundation.

See the [Phase 1 plan](docs/superpowers/plans/2026-08-31-v1.0-phase1-import-enrichment-export.md)
and its [design spec](docs/superpowers/specs/2026-08-31-v1.0-phase1-import-enrichment-export-design.md)
for what this phase covers and why.

## Structure

- `apps/web` — Next.js app (App Router), Auth.js v5 with GitHub OAuth
- `apps/cli` — commander CLI (`netpro init|config|import|enrich|search|outreach|analyze|track|export`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business-logic module boundaries (empty for now)
- `packages/ui` — shared React components
- `packages/config` — shared ESLint and Tailwind configs

See [`docs/getting-started.md`](docs/getting-started.md) to run it locally,
and [`docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md`](docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md)
for the design this scaffold implements.

## License

MIT
