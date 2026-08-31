# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

This repository is at the **v0.1-alpha scaffold** stage: the full monorepo
(CLI + web, dual-dialect Drizzle database, GitHub OAuth via Auth.js) builds,
lints, typechecks, and tests cleanly, with every command and route in place.
Feature logic — search, enrichment, AI outreach, CRM, campaigns — is not
implemented yet; each becomes its own future spec built on this foundation.

## Structure

- `apps/web` — Next.js app (App Router), Auth.js v5 with GitHub OAuth
- `apps/cli` — commander CLI (`netpro init|import|search|outreach|analyze|track|export`)
- `packages/db` — Drizzle ORM schema, dual SQLite/Postgres dialects
- `packages/core` — shared business-logic module boundaries (empty for now)
- `packages/ui` — shared React components
- `packages/config` — shared ESLint and Tailwind configs

See [`docs/getting-started.md`](docs/getting-started.md) to run it locally,
and [`docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md`](docs/superpowers/specs/2026-08-30-v0.1-alpha-scaffold-design.md)
for the design this scaffold implements.

## License

MIT
