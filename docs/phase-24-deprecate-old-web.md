# Phase 24 — Deprecate the old web architecture

**Generated:** 2026-09-11
**Follows:** [Phase 23](phase-23-security.md)

## Objective

With the new architecture stabilized (CLI ↔ standalone server ↔ pure-client Web
UI, phases 2–23), remove the Web UI's remaining legacy assumptions. Before this
phase the Web UI was a hybrid: the new server-backed pages lived next to the
original Next.js app, which still had its own API routes, its own database
access, its own Auth.js sign-in, and pages that reimplemented business logic in
the browser layer. Phase 24 deletes that second architecture so the Web UI has
exactly one job — visualize what the server already computed.

```text
before (hybrid)                          after (Phase 24)
─────────────────────                    ─────────────────────
Web UI: pages + app/api/* routes         Web UI: pages only (pure client)
        + Auth.js + direct DB                   │  NETPRO_SERVER_URL
        + duplicated business logic             ▼
                                         @netpro/server (routes orchestrate)
                                                 │
                                         @netpro/core (business logic)
                                                 │
                                         @netpro/db (SQLite / Postgres)
```

## What was removed

### The duplicated API surface — `apps/web/app/api/**` (deleted)

Every route the Web UI used to serve itself was a re-implementation of what the
standalone server already owns: `contacts`, `search`, `graph/overview`,
`graph/paths`, `analytics`, `health`, `import`, `enrich`, `events`, `settings`,
`skills`, `card` (+ `pixel.gif`/`view`/`views`), `content` (+ `metrics`/
`mentions`), `campaigns`, `follow-ups`, `outreach`, `interactions`, `export`,
`invites`, `workspaces`, `plugins`, `webhooks`, and the Auth.js
`auth/[...nextauth]` handler. The server's route table
(`packages/server/src/routes/index.ts`) is now the only API:

```text
GET  /api/health  /api/server-info  /api/identity
GET  /api/contacts  /api/contacts/:id
GET  /api/search
GET  /api/graph  /api/graph/path  /api/graph/visualization
GET  /api/analytics
GET  /api/import/:id   POST /api/import
POST /api/enrich        GET  /api/enrich/:id
GET  /api/jobs  /api/jobs/:id   POST /api/jobs  /api/jobs/:id/cancel
GET  /api/events  /api/events/stream
GET  /api/settings       PUT  /api/settings
POST /api/scan
GET  /api/providers
GET  /api/calendar-events  /api/calendar-events/:id
```

Features whose Web UI was the old architecture (profile card/view tracking,
content tracker, skills, events, webhooks, plugins, workspaces, outreach) remain
first-class in the CLI and `@netpro/core`; the Web UI no longer duplicates them.

### Duplicated business logic — `apps/web/lib/**` (deleted)

`db.ts` (a second database connection), `workspaces.ts`, `local-owner.ts`,
`owner.ts`, `authz.ts` (workspace scoping shims), `vault.ts`, `beacon.ts`,
`public-card.ts`, `card-request.ts`, `content.ts`, `content-request.ts`,
`crm-request.ts`, `events-request.ts`, `skills-request.ts`, `views-request.ts`,
`plugins.ts`, `provider-privacy.ts`, `retention.ts`, `search-config.ts`,
`graph-request.ts`, and `utils.ts` are gone. Each was either a re-derivation of
`@netpro/core` or a shim around the deleted API routes. The surviving helpers
are display-only: `lib/netpro-server.ts` (the server client) and `lib/format.ts`
(`scoreLabel`).

### Obsolete Auth.js flows

`lib/auth.ts`, `lib/auth.config.ts`, `lib/authz.ts`, `lib/auth-mode.ts`,
`lib/trust-host.ts`, `app/api/auth/[...nextauth]/route.ts`, `app/(auth)/login`,
`app/(app)/invite/**`, and the NextAuth `proxy.ts` middleware are deleted. The
Web UI performs no authentication and holds no session; the server's loopback/
token/open policy (phase 5) is the only authentication, and `GET /api/identity`
replaces the user profile the OAuth model used to show.

### Obsolete Next.js server actions and side effects

`proxy.ts` (middleware), `instrumentation.ts` (migrations + retention purge on
web boot), the sign-out server action in the app layout, and every
`"use server"`/`requireScope()` call are gone. The Web UI no longer writes to
the database, no longer runs migrations, and no longer gates routes. Its two
background duties were re-homed rather than dropped: migrations already ran in
the server (`NETPRO_AUTO_MIGRATE`), and the daily retention purge moved to
`packages/server/src/retention.ts` (wired into `netpro serve`), so a bounded
data window remains a server guarantee, not a web-boot side effect.

### Legacy pages

Deleted: `/dashboard`, `/contacts`, `/edges`, `/graph`, `/skills`, `/events`,
`/content`, `/outreach` (+ `campaigns`), `/invite`, the public `/card`, and the
settings sub-pages `/settings/card`, `/settings/team`, `/settings/activity`,
`/settings/plugins`, `/settings/webhooks`, `/settings/keys`. The private
settings page now shows installation identity + provider status.

### Old deployment configuration and cloud-only requirements

`docker-compose.yml`'s web service is a pure client: `NETPRO_SERVER_URL` only —
no `DB_DIALECT`, `DATABASE_URL`, `NETPRO_AUTH_MODE`, `NETPRO_TRUST_LOCAL_UI`,
`AUTH_URL`, `NEXTAUTH_*`, or GitHub variables. The Dockerfile healthcheck probes
the landing page instead of the web app's own `/api/health`. The server service
carries the database, auth, and bring-your-own-key provider variables. Auth.js,
`next-auth`, `@auth/drizzle-adapter`, `class-variance-authority`, `clsx`,
`tailwind-merge`, `@netpro/core`, and `@netpro/db` left `apps/web/package.json`;
`next.config.ts` no longer transpiles workspace packages.

## What remains (the final surface)

```text
/              landing / on-ramp
/observatory   server-driven stats grid
/network       graph visualization (client of /api/graph/visualization)
/people        contacts list (client of /api/contacts + /api/search)
/people/[id]   read-only contact detail (client of /api/contacts/:id)
/search        faceted + engine badge (client of /api/search + /api/providers)
/pathfinder    ranked intro paths (client of /api/graph/path)
/activity      job/SSE feed (client of /api/jobs + /api/events)
/scan          scan trigger + status (client of /api/scan + /api/jobs)
/import        import + status (client of /api/import + /api/jobs)
/settings      installation identity + provider status
```

Every page renders a useful shell when the server is down (naming `netpro
serve`), never a crash — there is no direct-DB fallback to hide a broken deploy.

## Exit criteria

| Criterion | Status |
|-----------|--------|
| `apps/web/app/api/**` (duplicated API) deleted | ✅ 60+ route files removed |
| `apps/web/lib/**` (duplicated business logic) deleted | ✅ 25 source files removed, only `netpro-server.ts` + `format.ts` remain |
| Auth.js flows, server actions, middleware, instrumentation removed | ✅ `auth*`/`trust-host`/`proxy.ts`/`instrumentation.ts` deleted |
| Legacy pages removed | ✅ 11-route final surface (see above) |
| Web UI imports no `@netpro/core` / `@netpro/db` / `next-auth` | ✅ typecheck + census clean |
| Docker/Compose web service is a pure client | ✅ `NETPRO_SERVER_URL` only |
| Web smoke asserts `/login` 404 and no `/api` of its own | ✅ `scripts/smoke/web-ui.sh` |
| Docker e2e runs server + web, asserts the client boundary + token-mode auth | ✅ `.github/workflows/ci.yml` |
| Daily retention purge re-homed to the server | ✅ `packages/server/src/retention.ts` + tests |
| Full pipeline green | ✅ lint (0 errors), typecheck, test, build, and all 3 smokes |
