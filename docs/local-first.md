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
├── config.toml    # user-editable configuration + this install's identity
├── netpro.db      # SQLite database (the default dialect)
├── logs/          # install logs
└── keys/          # key material: credentials.enc, access-token (mode 0600)
```

Set `NETPRO_HOME` to relocate the whole install (portable drives, tests,
multiple instances). Every component — CLI commands, the local server, the
encrypted CLI keychain — resolves the same directory.

### The installation identity

`netpro init` gives the install an identity in `config.toml` — this is what
"you" are locally, instead of a GitHub account:

```toml
[installation]
id = "ins_7a4546a7d03292e3ea3f4d4a"
created_at = "2026-09-10T17:25:30.542Z"
# owner = "Your name"
# email = "you@example.com"
```

It is generated once and never rewritten (hand edits and comments survive), and
`netpro status` prints it. The Web UI mirrors it into a local owner account so
workspaces, activity logs, and permissions work with no sign-in at all.

If you ever do expose the server beyond this machine, callers need the access
token instead:

```bash
netpro token            # print the token (np_…)
netpro token --rotate   # replace it
netpro token --path     # just the file location
```

It lives at `~/.netpro/keys/access-token` (mode `0600`), or in
`NETPRO_AUTH_TOKEN` if you mount it as a secret. Loopback callers never need it.

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
Identity: ins_7a4546a7d03292e3ea3f4d4a
Auth:     local — loopback trusted; access token set for remote callers

Web UI:   http://127.0.0.1:3777
```

- The URL serves the built-in console page (live health, database, API link).
- `GET /api/health` is the machine-readable readiness probe.
- Pending migrations are applied on startup (opt out with
  `NETPRO_AUTO_MIGRATE=false` and run `netpro migrate` yourself).
- `Ctrl+C` shuts down gracefully.

### Security model

The server binds to **127.0.0.1 by default**. Binding to `0.0.0.0`, `::`, or
any non-loopback address requires an explicit `--host` / config / env setting;
it prints a warning naming what is now reachable, and `local` mode mints an
access token for remote callers if one does not exist yet.

Three modes, set with `NETPRO_AUTH_MODE` or `[auth] mode` in `config.toml`:

| Mode | Who gets in |
|------|-------------|
| `local` (default) | Requests from this machine (real peer address `127.0.0.1`/`::1`, no proxy headers). Everyone else needs the access token. |
| `token` | Every caller, loopback included, needs the access token. |
| `open` | Nobody is authenticated — only behind your own auth (reverse proxy, VPN, private network). |

**GitHub OAuth is never required.** It remains available to the Web UI as an
optional integration (`NETPRO_AUTH_MODE=github` with `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`, and optionally
`NETPRO_OWNER_GITHUB_ID`) for instances reachable from other machines.

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

[auth]
# mode = "local"                  # local (default) | token | open

[installation]                    # written by netpro init; do not need to edit
id = "ins_…"
created_at = "…"
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
Dialect precedence: `DB_DIALECT` env → `[database] dialect` in config.toml →
**sqlite**. Nothing is inferred: a `DATABASE_URL` present in the environment
does not flip the dialect (Phase 4 removed the last platform inference).

Where many short-lived instances each hold a pool — containers scaled out,
function-style runtimes — set `NETPRO_SERVERLESS=1` so each instance keeps a
one-connection pool instead of multiplying into connection exhaustion.

## Inspection

```bash
netpro status          # install, database, identity/auth, and health in one screen
netpro status --json   # machine-readable
```

`status` never creates or migrates anything and never prints the token (only
whether one exists); a broken `config.toml` shows up as a status line (with the
parser's file-and-line error), not a crash.

## Related docs

- [docs/getting-started.md](getting-started.md) — install and first import
- [docs/deployment.md](deployment.md) — Docker / self-hosted PostgreSQL path
- [docs/phase-2-serve.md](phase-2-serve.md),
  [docs/phase-3-local-database.md](phase-3-local-database.md),
  [docs/phase-4-vercel-removal.md](phase-4-vercel-removal.md), and
  [docs/phase-5-authentication.md](phase-5-authentication.md) — the
  implementation reports for the phases that introduced this behaviour
