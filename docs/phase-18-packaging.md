# Phase 18 — Packaging and installation

NetPro can be installed as a single Node CLI. The published package is named
`netpro` and exposes the `netpro` executable; the workspace packages are bundled
into the CLI so an end user does not need to install the monorepo or know about
`@netpro/*` packages.

## End-user installation

Requirements:

- Node.js 20 or newer
- npm 10 or newer

```bash
npm install -g netpro
netpro --version
```

Initialize a local installation and start the server:

```bash
netpro init
netpro serve
```

`netpro init` is idempotent. It creates:

```text
~/.netpro/
├── config.toml
├── netpro.db
├── logs/
└── keys/
    └── access-token
```

SQLite is selected by default and no `DATABASE_URL`, PostgreSQL server, cloud
account, OAuth application, or provider key is required. The server defaults to
`127.0.0.1:3777`:

```text
NetPro server started

Local:    http://127.0.0.1:3777
Database: ~/.netpro/netpro.db

Web UI:   http://127.0.0.1:3777
```

The server's API and built-in local console are available at that address. The
full `apps/web` Observatory can also be run from a checkout and is a client of
the same server (`npm run dev -w apps/web`).

## Common commands

```bash
netpro status
netpro import linkedin.csv
netpro scan
netpro search "AI founders"
```

The CLI and server use the same `packages/core` operations and database
migrations. A command can be run from any working directory; the default data
location remains `~/.netpro`.

## Configuration and upgrades

Use environment variables for process-manager/container overrides, or edit
`~/.netpro/config.toml` for a local installation. Environment values take
precedence. For example:

```toml
[database]
dialect = "sqlite"
path = "~/.netpro/netpro.db"

[server]
host = "127.0.0.1"
port = 3777
```

PostgreSQL is explicit rather than inferred:

```bash
DB_DIALECT=postgresql \
DATABASE_URL='postgresql://user:password@host:5432/netpro?sslmode=require' \
netpro migrate
```

The npm package includes both SQLite and PostgreSQL migration journals. The
CLI bundle retains only the native database drivers as runtime dependencies;
all domain, server, and ORM JavaScript is bundled into the executable. This is
why the global install remains one command while PostgreSQL remains supported.

To update:

```bash
npm update -g netpro
netpro migrate
```

Back up `~/.netpro/netpro.db` before upgrades. SQLite WAL sidecar files should
not be copied while the database is active; stop `netpro serve` first or use a
SQLite-aware backup tool.

## Publishing from the repository

The repository root is the publishable `netpro` package. `apps/cli` remains a
workspace implementation package, while the root package provides the public
name and global `bin` entry point.

```bash
npm ci
npm run build -w apps/cli
npm run package:check
npm pack --dry-run
npm publish --access public
```

`prepack` rebuilds the CLI and verifies that the bundle, both migration
journals, and the `netpro` bin are present. Do not publish an ad-hoc
`apps/cli` tarball: it is a workspace package and is not the supported global
installation artifact.

## Security notes

The access token created by `netpro init` is mode `0600` and is not printed in
full. Loopback requests are trusted in the default `local` mode. If the server
is intentionally bound to a non-loopback address, use `netpro token` and an
explicit authentication/network policy; do not expose local mode directly to
the public internet.
