# Local-First NetPro

NetPro runs entirely on your machine. One command starts everything:

```bash
netpro init      # once: create the install (~/.netpro) and database
netpro serve     # start the local server + Web UI
```

No cloud account, no hosted platform, no GitHub OAuth, no `DATABASE_URL`. Your
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
`netpro status` prints it. The Web UI reads it from `GET /api/identity` (Phase
24 — the Web UI no longer writes to the database, so the owner account comes
from the server, and workspaces, activity logs, and permissions work with no
sign-in at all).

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

Local:    http://127.0.0.1:3777  (API + built-in console)
Database: ~/.netpro/netpro.db
Identity: ins_7a4546a7d03292e3ea3f4d4a
Auth:     local — loopback trusted; access token set for remote callers

Web UI:   not running — start it with `npm run dev -w apps/web`
          (set NETPRO_WEB_URL or [server] web_url once it has a fixed address)
```

- The URL serves the REST API and the built-in console page (live health,
  database, API link). It is **not** the full Web UI.
- The Web UI is the separate Next.js app in `apps/web` (Observatory, People,
  Search, Import, Settings), a pure HTTP client of this server that runs on its
  own port — `http://localhost:3000` under `npm run dev -w apps/web`. Tell the
  server where it lives with `NETPRO_WEB_URL` (or `[server] web_url`) and the
  banner prints that address instead of "not running"; the server never serves
  the UI itself.
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

| Mode              | Who gets in                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `local` (default) | Requests from this machine (real peer address `127.0.0.1`/`::1`, no proxy headers). Everyone else needs the access token. |
| `token`           | Every caller, loopback included, needs the access token.                                                                  |
| `open`            | Nobody is authenticated — only behind your own auth (reverse proxy, VPN, private network).                                |

**GitHub OAuth is never required.** Phase 24 removed the Web UI's Auth.js flows
entirely — the Web UI is a pure client of this server and performs no
authentication of its own. To expose a server beyond this machine, use `token`
mode (or `open` behind your own reverse proxy / VPN), or put your own auth in
front of the Web UI.

## Configuration

Settings layer, highest wins:

1. **CLI flags** (`netpro serve --host … --port …`)
2. **Environment variables** — `NETPRO_HOST`/`HOST`, `NETPRO_PORT`/`PORT`,
   `NETPRO_AUTO_MIGRATE`, `NETPRO_URL` (status probes), `NETPRO_WEB_URL` (the
   separate Web UI's address, shown in the banner), plus the database
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
# web_url = "http://localhost:3000"  # Where apps/web runs, for the serve banner.
#                                    # Display only — the server never serves the UI.

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

## One operation, two interfaces

Every long-running NetPro operation is **one** core implementation, **one** job,
and **one** event stream — the terminal and the Web UI are just two clients of
it (Phase 16):

```bash
netpro import linkedin.csv   # visible in the Web UI's Import/Activity while it runs
netpro scan                  # reindex + (optional) enrichment + graph analysis
netpro scan --local          # run the sweep in this process, even with a server up
netpro scan --json           # machine-readable job + result snapshot
```

When a NetPro server is running, `netpro scan` asks **that server** for the
scan — the same job the Web UI's Scan view renders, with the same
`scan.progress` ladder over `GET /api/events` — and prints the progress in the
terminal:

```text
Scan started on the NetPro server (http://127.0.0.1:3777) — job d8080425
   15% Discovering contacts
   40% Processing contacts
   70% Indexed 128 contact(s)
   90% Analyzing graph
  100% Scan complete
```

With no server running, the CLI runs the identical sweep in-process
(`runScan` in `@netpro/core`) and mirrors its events to the server if one
appears. Either way the job records which interface started it
(`metadata.origin`: `cli` or `web`).

## Optional providers

NetPro needs no external account. OpenAI, Anthropic, Hunter, People Data Labs,
Clearbit, and embedding providers are all **enhancements** — with none
configured, NetPro still imports, scans, searches, and analyses (Phase 17):

```bash
netpro status            # ends with the provider block
netpro status --json     # …and the same snapshot, machine-readable
```

```text
Providers (all optional — NetPro runs without them)
  AI           ● Not configured
  Enrichment   ● Hunter configured
  Embeddings   ● Disabled
```

The Web UI shows the same strips in **Settings** (from `GET /api/providers`)
and, compactly, on **/scan**, including what is switched off and the exact
command or environment variable that turns it on. Keys live in the environment
or in the CLI's encrypted keychain (`netpro config set enrichment.hunter …`);
no surface — CLI, API, or UI — ever prints one.

## Related docs

- [docs/getting-started.md](getting-started.md) — install and first import
- [docs/deployment.md](deployment.md) — Docker / self-hosted PostgreSQL path
- [docs/webhooks.md](webhooks.md) — outbound webhook receivers
