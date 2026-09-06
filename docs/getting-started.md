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
