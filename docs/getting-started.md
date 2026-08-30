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
