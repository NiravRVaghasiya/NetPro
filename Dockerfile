# NOTE: an earlier version of this Dockerfile used node:22-alpine because
# @netpro/db's dependency better-sqlite3@13.0.3 declares `engines.node: >=22`
# — it compiled against Node 20 headers via node-gyp without error, but the
# resulting native addon segfaulted (SIGSEGV) at runtime, since it's loaded
# unconditionally (packages/db/src/index.ts does a static top-level
# `import Database from 'better-sqlite3'` regardless of DB_DIALECT).
# Reconciled with the workspace-wide Node >=20 floor (root/apps package.json
# `engines`, planned CI `node-version: '20'`) by pinning better-sqlite3 to
# ^12.11.1 instead — the newest 12.x release whose `engines.node` still lists
# `20.x` — rather than raising the floor project-wide, consistent with how
# Task 7 handled the same class of conflict with `commander@15`. All three
# stages are back on node:20-alpine.
#
# Pinning alone left a second bug: npm's workspace hoisting nests
# better-sqlite3@12.11.1 inside packages/db/node_modules instead of the root
# node_modules (13.0.3 hoisted to root; 12.11.1 reproducibly does not, on a
# from-scratch `npm install`, even with `overrides` or `dedupe` — this looks
# like an Arborist placement quirk specific to this dependency shape, not a
# real version conflict). Since drizzle-orm sits in root node_modules and does
# a static `import ... from "better-sqlite3"` in its own driver file, Node's
# module resolution can't find a nested copy from there — `next build` fails
# with "Module not found: Can't resolve 'better-sqlite3'". Fixed by also
# declaring `better-sqlite3` as a direct root `dependencies` entry (see root
# package.json), which forces it to hoist to root and resolves cleanly for
# both `next build` and this Dockerfile's `npm ci`.

# ── Stage 1: Dependencies ──
FROM node:20-alpine AS deps
WORKDIR /app
# python3/make/g++ are required by node-gyp to compile better-sqlite3's native
# addon (@netpro/db imports better-sqlite3 unconditionally, so it must build
# even though this compose stack only runs the postgresql dialect at runtime).
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/cli/package.json ./apps/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/config/package.json ./packages/config/
COPY packages/server/package.json ./packages/server/
RUN npm ci

# ── Stage 2: Build ──
FROM node:20-alpine AS builder
WORKDIR /app
# libc6-compat is Next.js's own standard recommendation for Alpine (musl)
# images, so Node-native addons and the SWC/Turbopack binary have the glibc
# compatibility shims they may probe for. Harmless to include even though it
# was not, by itself, the fix for the segfault described above.
RUN apk add --no-cache libc6-compat
# Copy the *whole* installed layout, not just the root node_modules. npm
# workspaces nest a dependency under apps/<pkg>/node_modules whenever the
# hoisted root copy would conflict, and commander is exactly that case:
# tsup's own sucrase dependency pins commander@4, which wins the root slot,
# so the CLI's commander@14 is installed at apps/cli/node_modules/commander.
#
# Copying only ./node_modules silently left the builder with commander@4.
# tsup resolved that, bundled it, and the image failed at runtime with
# "TypeError: config.command(...).argument is not a function" — .argument()
# was added in commander@9. Copying the workspace directories keeps whatever
# npm ci actually resolved, with no per-package list to keep in sync.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Browser-side server requests need a host-reachable origin. It is a build
# argument because Next.js inlines NEXT_PUBLIC_* values into client bundles.
ARG NEXT_PUBLIC_NETPRO_SERVER_URL=http://127.0.0.1:3777
ENV NEXT_PUBLIC_NETPRO_SERVER_URL=$NEXT_PUBLIC_NETPRO_SERVER_URL
# Build the CLI too: the compose stack runs `netpro migrate` as a one-shot
# migration job before the web service starts, so the deploy path uses the
# exact same command an operator runs by hand. Build the standalone API server
# as well; Compose runs it beside the Web UI so server-driven Observatory,
# Network, Search, People, and Activity pages use the same API as `netpro serve`.
RUN npm run build -w apps/web \
  && npm run build -w apps/cli \
  && npm run build -w @netpro/server
# Fail the build, not the container, if the bundled CLI is broken. Both bugs
# fixed here (a missing external, then a bundled commander@4) produced an
# image that built cleanly and only died when `netpro migrate` ran. `--help`
# exercises module resolution and the full command tree without a database.
RUN node apps/cli/dist/index.js --help > /dev/null \
  && node apps/cli/dist/index.js config --help > /dev/null \
  && node packages/server/dist/bin.js --help > /dev/null

# ── Stage 3: Production runner ──
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 netpro && adduser --system --uid 1001 netpro

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
# The bundled CLI, standalone API server, and the native drivers they need at
# runtime. tsup inlines every pure-JS dependency (commander, drizzle-orm,
# @netpro/*) into their dist files and marks only better-sqlite3 and pg as
# external, because better-sqlite3 is a native addon and pg is CommonJS that
# resolves its backends dynamically. Only those drivers need to exist in
# node_modules for `netpro migrate` and `netpro serve` to run in this image.
#
# Keep this list in sync with `external` in apps/cli/tsup.config.ts. An earlier
# revision left commander and drizzle-orm unbundled but never copied them here,
# so the image built fine and then died at runtime with ERR_MODULE_NOT_FOUND.
# apps/cli/src/bundle.test.ts now asserts both ends of that contract.
COPY --from=builder /app/apps/cli/dist ./apps/cli/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# bindings and file-uri-to-path are better-sqlite3's own runtime requires.
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
# pg is CommonJS that resolves its backends dynamically, so tsup keeps it
# external (see apps/cli/tsup.config.ts). It used to survive here only by
# accident: Next.js's standalone trace pulled pg and its transitive deps into
# the image because the Web UI imported @netpro/db. Phase 24 removed those
# imports, so the Web UI is a pure client and the trace no longer carries pg —
# the `netpro migrate` job then died with "Cannot find module 'pg-types'". Copy
# pg's full runtime closure explicitly. Keep this list in sync with the `pg`
# `dependencies` in its package.json; apps/cli/src/bundle.test.ts asserts it.
COPY --from=builder /app/node_modules/pg ./node_modules/pg
COPY --from=builder /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=builder /app/node_modules/pg-int8 ./node_modules/pg-int8
COPY --from=builder /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=builder /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=builder /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=builder /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=builder /app/node_modules/xtend ./node_modules/xtend
COPY --from=builder /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=builder /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=builder /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=builder /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
# Next.js's standalone output already places the workspace packages (and the
# committed migration SQL) at /app/packages/db, which is one of the resolver's
# candidate paths, so no extra copy of the migrations is needed here.
# v3.0 Phase 6: the plugin runtime discovers ./plugins relative to the
# workdir, so a self-hosted container ships the reference plugin and the
# marketplace index it installs from. (On a read-only filesystem, point
# NETPRO_PLUGIN_DIR at a writable volume for web installs.)
COPY --from=builder /app/plugins ./plugins
COPY --from=builder /app/marketplace ./marketplace
# Keep migrations explicit rather than relying on Next standalone tracing. The
# bundled `netpro migrate` command also runs in the compose init job, and the
# published CLI uses the same directory layout.
COPY --from=builder /app/packages/db/migrations ./packages/db/migrations

# Marketplace installs and plugin-generated files need a writable, persistent
# location. The compose file mounts a named volume here; copying the reference
# plugin gives a newly-created volume useful contents on its first start.
RUN mkdir -p /data/plugins \
  && cp -a ./plugins/. /data/plugins/ \
  && chown -R netpro:netpro /data /app/plugins /app/marketplace /app/packages/db/migrations
ENV NETPRO_PLUGIN_DIR=/data/plugins

USER netpro
EXPOSE 3000 3777

# 127.0.0.1, not localhost: inside this Alpine container "localhost" resolves
# to ::1 (IPv6) first, but Next.js's standalone server only binds the IPv4
# 0.0.0.0 — wget against "localhost" reliably gets "Connection refused" even
# though the server is up and answering fine on 127.0.0.1. Verified directly
# with `docker exec ... wget http://localhost:3000/...` (fails) vs
# `wget http://127.0.0.1:3000/...` (succeeds) against a running container.
# Phase 24 — the Web UI has no /api routes of its own, so the healthcheck
# probes the landing page. The standalone @netpro/server (compose `server`
# service) carries its own /api/health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/web/server.js"]
