# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

**v1.0 Phases 1–3 are implemented** on top of the v0.1-alpha scaffold:

- **Phase 1 — Import, Enrichment & Export:** LinkedIn CSV import with
  dedup/merge, three-provider contact enrichment (Hunter.io, People Data Labs,
  Clearbit), and CSV export.
- **Phase 2 — People Search:** faceted full-text search over your contacts —
  free-text query plus company/role/location/industry/seniority/email/score/
  activity filters, relevance/score/recent/name sorting, facets, and
  pagination — wired into both the CLI (`netpro search`) and the web app
  (`/search`, `GET /api/search`).
- **Phase 3 — Network Analytics:** a composite network health score,
  activity/dormancy breakdown, 12-month growth series, industry/company
  diversity (Shannon entropy), company clusters, and the dormant-ties
  reconnect list — computed in `packages/core/analytics` and surfaced through
  `netpro analyze` and the web dashboard (`/dashboard`, `GET /api/analytics`).
  Imports now persist LinkedIn's "Connected On" date, so growth reflects when
  relationships actually formed.

The full monorepo (CLI + web, dual-dialect Drizzle database, GitHub OAuth via
Auth.js) builds, lints, typechecks, and tests cleanly. Remaining v1.0 features
— AI outreach, profile card, one-click Vercel deploy — are still stubs; each
becomes its own future spec built on this foundation.

> **Analytics scope note:** clustering is attribute-based (normalized company)
> for now — the blueprint's graph-native analytics (Louvain communities,
> centrality, warm-intro paths) need the `edges` table, which no producer
> populates yet. They build on the same `analytics` module entry points in a
> later phase, alongside per-contact relationship scoring once interaction
> logging (CRM) exists.

> **Search implementation note:** this is the v1 _portable_ search —
> case-insensitive substring matching and facets in ANSI SQL that runs
> identically on SQLite and Postgres. The blueprint's hybrid engine (SQLite
> FTS5 + pgvector embeddings with RRF re-ranking) is deferred to a later
> phase and will build on the same `searchContacts` entry point.

See the [Phase 1 plan](docs/superpowers/plans/2026-08-31-v1.0-phase1-import-enrichment-export.md)
and its [design spec](docs/superpowers/specs/2026-08-31-v1.0-phase1-import-enrichment-export-design.md)
for what Phase 1 covers and why, the
[Phase 3 design spec](docs/superpowers/specs/2026-09-06-v1.0-phase3-network-analytics-design.md)
for the analytics decisions.

## Structure

- `apps/web` — Next.js app (App Router), Auth.js v5 with GitHub OAuth
- `apps/cli` — commander CLI (`netpro init|config|import|enrich|search|outreach|analyze|track|export`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business logic: import, enrichment, export, faceted search, and the network analytics engine (AI/CRM modules remain placeholders)
- `packages/ui` — shared React components
- `packages/config` — shared ESLint and Tailwind configs

See [`docs/getting-started.md`](docs/getting-started.md) to run it locally,
and [`docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md`](docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md)
for the design this scaffold implements.

## License

MIT
