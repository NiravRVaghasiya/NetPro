# Phase 5 — Redesign Authentication

**Generated:** 2026-09-10
**Branch:** `arena/01a08c45-netpro`
**Follows:** [Phase 4](phase-4-vercel-removal.md)

## Objective

Remove GitHub OAuth as a prerequisite for local NetPro. Local mode must not
require `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NETPRO_OWNER_GITHUB_ID`,
`NEXTAUTH_SECRET`, or `NEXTAUTH_URL`; a local installation identity
(`~/.netpro/config.toml`) identifies the install; a server bound to
`127.0.0.1` may trust its local UI; remote/self-hosted deployments may enable
authentication, with GitHub OAuth demoted to an optional integration.

Exit criterion: **local NetPro starts without GitHub credentials.**

---

## The model

One question — *who is calling?* — answered in one place per process:

| Mode | Set with | Meaning |
|------|----------|---------|
| `local` (default) | `NETPRO_AUTH_MODE=local`, `[auth] mode = "local"`, or nothing | A request straight from this machine (`127.0.0.1`, `::1`) and not through a proxy is the operator. Everything else needs the access token (server) or GitHub sign-in / its own front door (Web UI). |
| `token` | `NETPRO_AUTH_MODE=token`, `[auth] mode = "token"` | Every caller presents the access token, loopback included. For shared machines and explicit setups. |
| `open` | `NETPRO_AUTH_MODE=open`, `[auth] mode = "open"` | NetPro authenticates nobody. Only correct behind a reverse proxy, a VPN, or an isolated network. |

Resolution order for the server: `NETPRO_AUTH_MODE` → `[auth] mode` in
`~/.netpro/config.toml` → `local`. An unrecognised value is a loud error, never
a silent fallback — a typo must not choose the security policy.

The Web UI resolves its own mode from `NETPRO_AUTH_MODE`:
`open` → open; `github` → GitHub OAuth; `local`/`token` → local (a browser
cannot attach a bearer token to a navigation); unset → `github` **if**
`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are present (existing deployments
are unchanged), else `local`.

---

## Local installation identity

`netpro init` writes and `netpro status`/`netpro serve` read an identity in the
install's `config.toml`:

```toml
[installation]
id = "ins_7a4546a7d03292e3ea3f4d4a"   # 24 hex chars; generated once
created_at = "2026-09-10T17:25:30.542Z"
# owner = "Your name"                  # optional, free-form
# email = "you@example.com"
```

- `upsertInstallationSection()` fills in only missing keys: hand-written values,
  comments, ordering, and CRLF line endings survive. A second `netpro init`
  reuses the identity (test-pinned) and never rewrites it.
- The portal is deliberately tolerant of a read-only home: components fall back
  to an in-memory identity and warn rather than refusing to start.
- The Web UI mirrors the identity into a deterministic `users` row
  (`local:<installation id>`) and ensures it owns the bootstrap workspace, so
  membership, activity logging, retention, and every `requireScope()` keep
  working with no OAuth round-trip. The row is insert-only
  (`onConflictDoNothing`) — an edited name is never clobbered.

### Access token

For callers that are not the local operator:

```text
~/.netpro/keys/access-token     # mode 0600, one line: np_<32 random bytes, base64url>
```

- `netpro token` prints it; `netpro token --rotate` replaces it;
  `--path` prints the location and `--json` the structured result.
- `NETPRO_AUTH_TOKEN` takes precedence over the file, so a mounted secret works
  on a read-only filesystem.
- `netpro init` mints one (0600) and prints a redacted preview — never the
  token itself. `netpro serve` mints one only when it is about to bind a
  non-loopback address in `local` mode, and prints it once with a warning.
- Comparison is constant-time over SHA-256 digests (`tokensEqual`), so a
  wrong token cannot be distinguished by timing.

---

## Server (`packages/server`)

- `packages/server/src/auth/index.ts` owns the request-time decision:
  `resolveAuthContext(info, policy)` returns
  `{ mode, authenticated, trustedLocal, kind, installationId, reason? }` with
  `kind ∈ loopback | token | open | anonymous`.
- Credentials are accepted as `Authorization: Bearer np_…`, `X-NetPro-Token`,
  or `?token=` (the query form exists for `EventSource`, which cannot set
  headers). A node whose header cannot be trusted is never trusted: presence of
  `x-forwarded-for`, `x-real-ip`, or `forwarded` withholds the loopback
  shortcut even when the TCP peer is local.
- `loadConfig().auth.mode` makes the mode part of the server config, and
  `createApp({ auth })` accepts an injected policy so tests (and later phases)
  can pin the decision.
- Public by design: `/api/health`, `/health`, `/api/server-info` — terse
  readiness probes that must work before anyone holds a credential. `/api/identity`
  answers the authenticated caller with the installation id/owner, the auth
  mode, and whether a token exists — never the token.
- Everything else under `/api/*` and the console page at `/` require
  authentication: JSON `401 {error, reason, authMode, hint}` with
  `WWW-Authenticate: Bearer realm="netpro"` for APIs, and a locked HTML page
  for `/`. Unknown future `/api/*` routes fail closed by construction.
- The console page and `/api/identity` render the identity, so "which install
  is this?" is answerable without a login. `netpro serve` prints
  `Identity:`/`Auth:` lines and the one-time token note.

## CLI (`apps/cli`)

```text
netpro init     create ~/.netpro, the database, the identity, and a 0600 token
netpro status   install, database, Identity:, Auth: (mode + token) and health
netpro token    print the access token (--rotate, --path, --json)
netpro serve    banner shows Identity/Auth; warns on non-loopback binds
```

`status` is still read-only: it reports the mode and token *configuration*
(not the token), and a broken `config.toml` remains a status line rather than a
crash.

---

## Web UI (`apps/web`)

- `lib/auth-mode.ts` (edge-safe, imported by `proxy.ts`) resolves the mode and
  answers "is this request directly from this machine?" — loopback Host
  (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and no proxy headers.
- `lib/local-owner.ts` turns the installation identity into an Auth.js-shaped
  session; `auth()` in `lib/auth.ts` is now a dispatcher: `open` → local owner,
  `local` + loopback → local owner, otherwise the Auth.js session (which is
  `null` unless GitHub sign-in is configured). Every existing call site
  (`requireScope()`, the `(app)` layout gate, the beacon, health's verbose
  mode) therefore works without OAuth.
- `proxy.ts` (the request boundary) returns an explicit **500** with the
  message when `NETPRO_AUTH_MODE` is misspelled, trusts loopback in local mode
  without reading a session or setting a cookie, and otherwise applies the
  existing public/private route rules.
- The login page explains each mode: "continue to the dashboard" locally,
  GitHub sign-in in `github` mode, and — for a remote caller on a local-mode
  instance — exactly which variable to set. Settings shows the installation
  identity and treats GitHub as an optional integration.

### The caveat, stated plainly

In `local` mode the Web UI trusts a loopback `Host` header, because a Next.js
process cannot see the peer's socket address. It additionally requires that
every address in `x-forwarded-for` / `x-real-ip` / `Forwarded` is loopback
(Next.js fills `x-forwarded-for` from the socket itself, so a direct request
satisfies this and a request that travelled through a proxy does not). A caller
who can reach the port can still claim `Host: localhost`. Therefore: **in local
mode, publish the Web UI on loopback only** — `127.0.0.1:3000`, which
`docker-compose.yml` does by default — and switch to `NETPRO_AUTH_MODE=github`
(or `open` behind your own auth) before exposing it.

Inside a container the socket peer is the Docker bridge, so that check cannot
pass on its own. `NETPRO_TRUST_LOCAL_UI=1` is the operator's assertion that the
instance is reachable only from this machine; the shipped compose file sets it
alongside a `127.0.0.1` port publish. The NetPro server itself does not share
this caveat: it checks the real peer address.

---

## Exit criteria

| Criterion | Status |
|-----------|--------|
| Local NetPro starts without GitHub credentials | ✅ `netpro init` + `netpro serve` with an empty environment; smoke-tested and asserted in CI's docker job (no `GITHUB_*`, no `NETPRO_OWNER_GITHUB_ID`, no `NEXTAUTH_*`) |
| None of the five variables is required anywhere | ✅ server: `packages/server/src/{config,auth,serve}`; web: `lib/auth-mode.ts` defaults to local; compose/env examples mark them optional |
| Installation identity in `~/.netpro/config.toml` | ✅ `[installation] id/created_at/owner/email`, written once, comment-preserving |
| Loopback requests may be trusted | ✅ `isDirectLoopbackRequest()` (server, socket-based) and `isTrustedLocalRequest()` (web, Host-based, documented caveat) |
| Remote/self-hosted auth can be enabled | ✅ `token` mode + access token today; `github`/`open` for the Web UI; OIDC/reverse-proxy auth slots into the same mode switch in a later phase |
| GitHub OAuth is optional | ✅ provider registered only when the credentials exist; `github` mode auto-selected only to preserve existing deployments |

## Tests added

- `packages/db/src/identity.test.ts` — identity generation/minting/idempotence,
  fill-in-only merge (hand-written keys, comments, CRLF), token mode 0600,
  `NETPRO_AUTH_TOKEN` precedence, empty-file handling, redaction.
- `packages/db/src/local.test.ts` — `[installation]`/`[auth]` parsing,
  unknown-key and bad-value rejection, `resolveAuthMode` precedence.
- `packages/server/src/auth.test.ts` + `{app,config,serve}.test.ts` — loopback
  and proxy-header rules, token extraction and constant-time compare, 401
  shapes, `/api/identity`, banner/token-mint paths, mode precedence and errors.
- `apps/cli/src/commands/{init,token}.test.ts` — identity + token on `init`
  (0600, redacted output, kept on re-run), `token` create/rotate/`--path`/`--json`.
- `apps/web/lib/auth-mode.test.ts`, `proxy.test.ts` — mode resolution, loopback
  Host rules, proxy-header withholding, open/token modes, 500 on a typo, and
  the public/private route matrix unchanged.
