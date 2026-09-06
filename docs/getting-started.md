# Getting Started

## Prerequisites

- Node.js >= 20
- Docker (only needed for the Postgres/self-hosted path)

## Install

```bash
npm install
```

## Run the web app (SQLite, local)

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev -w apps/web
```

Visit http://localhost:3000.

## Run the CLI

```bash
npm run build -w apps/cli
node apps/cli/dist/index.js --help
```

## Import your connections

```bash
node apps/cli/dist/index.js import --linkedin ~/Downloads/Connections.csv
```

The first run creates and migrates the local database (`./netpro.db`)
automatically. Re-importing the same file merges instead of duplicating.

## Enrich contacts (optional — requires your own API keys)

```bash
node apps/cli/dist/index.js config set enrichment.hunter YOUR_HUNTER_API_KEY
node apps/cli/dist/index.js config set enrichment.pdl YOUR_PDL_API_KEY
node apps/cli/dist/index.js config set enrichment.clearbit YOUR_CLEARBIT_API_KEY
node apps/cli/dist/index.js enrich --source all
```

Enrichment is BYO-key — without a configured key, each provider is skipped
(not an error). For the web app, set `HUNTER_API_KEY`/`PDL_API_KEY`/`CLEARBIT_API_KEY`
as server-side environment variables instead (see `apps/web/.env.example`).

## Export your contacts

```bash
node apps/cli/dist/index.js export --format csv --output contacts.csv
```

## Search your contacts

Free-text search plus faceted filters (all flags optional; combine freely):

```bash
# Free-text across name, email, company, role, headline, location
node apps/cli/dist/index.js search vercel engineer

# Filter by company / role / location / seniority
node apps/cli/dist/index.js search --company stripe --role engineer
node apps/cli/dist/index.js search --seniority c_level --has-email

# Minimum relationship score, recent activity, sorting, pagination
node apps/cli/dist/index.js search --min-score 0.5 --active-within 30
node apps/cli/dist/index.js search --sort name --limit 10 --offset 20

# Machine-readable output (contacts, total, facets)
node apps/cli/dist/index.js search stripe --json
```

Sort options: `relevance` (default), `score` (relationship score), `recent`
(last interaction), `name`. In the web app, use the **Search** page
(`/search`) — it has the same query/filter/sort/facet/pagination controls and
calls `GET /api/search`.

> Search runs in portable ANSI SQL on both SQLite and Postgres. The blueprint's
> hybrid FTS5 + vector-semantic search is a later phase; it builds on the same
> `searchContacts` core entry point.

## Analyze your network

```bash
# Full report: network score, activity, diversity, growth, clusters, dormant ties
node apps/cli/dist/index.js analyze

# Section views
node apps/cli/dist/index.js analyze --network-score
node apps/cli/dist/index.js analyze --clusters
node apps/cli/dist/index.js analyze --dormant --days 60 --limit 20

# Machine-readable output (the full overview payload)
node apps/cli/dist/index.js analyze --json
```

In the web app, the **Dashboard** page (`/dashboard`) renders the same numbers
from `GET /api/analytics`: metric cards, a 12-month growth chart, top
companies/industries, clusters, and your reconnect list.

> Analytics reads LinkedIn's "Connected On" date — imports record it as the
> contact's `createdAt` and initial `lastInteraction`, so growth reflects when
> relationships actually formed, not when the CSV was imported. Graph-native
> analytics (Louvain clusters, centrality, paths) arrive with the phase that
> populates the `edges` table; per-contact relationship scoring arrives with
> interaction logging (CRM).

## Draft AI outreach

NetPro drafts personalized outreach from your contact data — **you** review and
send it (nothing is ever emailed automatically). Bring your own API key:

```bash
# CLI: store the key encrypted in ~/.netpro, or set OPENAI_API_KEY in the env
netpro config set ai.openai.key sk-...          # or: ai.anthropic.key
netpro outreach --to jane@stripe.com \
  --context "met at React Conf after the WASM talk" \
  --purpose "a 15-minute call about OSS collab" --tone warm

# Someone not in your network yet:
netpro outreach --name "Pat Lee" --email pat@newco.com --company NewCo --role CTO
netpro outreach --to "Jane Doe" --json           # scriptable JSON output
```

The web app drafts from the **Outreach** page (`/outreach`, backed by
`POST /api/outreach`) — pick a contact or fill in a new recipient, choose a
tone, and add context. Configure the server with `AI_PROVIDER`,
`OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`), optionally `OPENAI_BASE_URL` for an
OpenAI-compatible endpoint, and `OPENAI_MODEL`/`ANTHROPIC_MODEL` overrides; the
**Settings** page shows which integrations are configured. Batch campaigns and
actual email delivery (SMTP) are planned for a later release.

## Verify everything

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Self-host with Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d
```
