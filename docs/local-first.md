# Local-First NetPro

NetPro runs entirely on your machine. One command starts everything:

```bash
netpro init      # once: create the install (~/.netpro) and database
netpro serve     # start the local server + Web UI
```

No cloud account, no Vercel, no GitHub OAuth, no `DATABASE_URL`. Your
professional network stays on your machine.

---

## The local install

Everything NetPro stores lives in one directory — `~/.netpro` by default:

```text
~/.netpro/
├── config.toml    # user-editable configuration (created by netpro init)
├── netpro.db      # SQLite database (the default dialect)
├── logs/          # install logs
└── keys/          # key material (credentials.enc lives here today)
```

Set `NETPRO_HOME` to relocate the whole install (portable drives, tests,
multiple instances). Every component — CLI commands, the local server, the
encrypted CLI keychain — resolves the same directory.

## `netpro serve`

```bash
netpro serve [--host <host>] [--port <port>]
```

Starts the local HTTP server (`packages/server` — plain `node:http`, no
framework) and prints:

```text
NetPro server started

Local:    http://127.0.0.1:3777
Database: ~/.netpro/netpro.db

Web UI:   http://127.0.0.1:3777
```

- The URL serves the built-in console page (live health, database, API link).
- `GET /api/health` is the machine-readable readiness probe.
- Pending migrations are applied on startup (opt out with
  `NETPRO_AUTO_MIGRATE=false` and run `netpro migrate` yourself).
- `Ctrl+C` shuts down gracefully.

### Security model

The server binds to **127.0.0.1 by default and only by default**. Binding to
`0.0.0.0`, `::`, or any non-loopback address requires an explicit
`--host` / config / env setting, and prints a warning when used: remote
exposure is opt-in, and full remote-auth hardening is a later phase of the
local-first plan. On loopback, the local server trusts local callers —
GitHub OAuth is never required.

## Configuration

Settings layer, highest wins:

1. **CLI flags** (`netpro serve --host … --port …`)
2. **Environment variables** — `NETPRO_HOST`/`HOST`, `NETPRO_PORT`/`PORT`,
   `NETPRO_AUTO_MIGRATE`, `NETPRO_URL` (status probes), plus the database
   variables below
3. **`~/.netpro/config.toml`**
4. **Defaults** — loopback, port 3777, SQLite

`config.toml` (as written by `netpro init`; uncomment to change):

```toml
[database]
# dialect = "sqlite"              # "sqlite" (default) or "postgresql"
# path = "~/.netpro/netpro.db"    # SQLite file (~/ expanded; relative = install dir)
# url = "postgresql://…"          # Required when dialect = "postgresql"

[server]
# host = "127.0.0.1"              # Loopback by default — expose deliberately.
# port = 3777
```

The parser accepts the documented subset (sections, strings, integers,
floats, booleans, comments) and **fails loudly with a line number** on
anything else — a typo must never be silently ignored.

## Database

**SQLite is the default dialect.** A fresh install needs nothing:

- Path precedence: `DB_PATH` env → `[database] path` in config.toml
  (relative paths resolve against the install directory, `~/` expands) →
  `<home>/netpro.db`.
- Parent directories are created automatically; the database opens in WAL
  mode with a 5 s busy timeout, so the CLI and a running server can share it.
- `DATABASE_URL` is **never required** for local use — even if one is set in
  the environment, the dialect stays sqlite unless you say otherwise.

**PostgreSQL is opt-in**, for Docker deployments, teams, and remote servers:

```toml
[database]
dialect = "postgresql"
url = "postgresql://user:password@host:5432/netpro"
```

or with environment only: `DB_DIALECT=postgresql` + `DATABASE_URL`.
Dialect precedence: `DB_DIALECT` env → config.toml → (legacy Vercel
inference from `DATABASE_URL`) → sqlite.

One legacy inference remains until the Vercel-removal phase: on Vercel with
`DATABASE_URL` set and no explicit dialect, postgresql is assumed (SQLite is
never usable on its ephemeral filesystem — `createDb` still refuses loudly).

## Inspection

```bash
netpro status          # install, database, and server health in one screen
netpro status --json   # machine-readable
```

`status` never creates or migrates anything; a broken `config.toml` shows up
as a status line (with the parser's file-and-line error), not a crash.

## Related docs

- [docs/getting-started.md](getting-started.md) — install and first import
- [docs/deployment.md](deployment.md) — Docker / self-hosted PostgreSQL path
- [docs/phase-2-serve.md](phase-2-serve.md) and
  [docs/phase-3-local-database.md](phase-3-local-database.md) — the
  implementation reports for the phases that introduced this behaviour
