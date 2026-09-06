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
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/
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
# Build the CLI too: the compose stack runs `netpro migrate` as a one-shot
# migration job before the web service starts, so the deploy path uses the
# exact same command an operator runs by hand.
RUN npm run build -w apps/web && npm run build -w apps/cli
# Fail the build, not the container, if the bundled CLI is broken. Both bugs
# fixed here (a missing external, then a bundled commander@4) produced an
# image that built cleanly and only died when `netpro migrate` ran. `--help`
# exercises module resolution and the full command tree without a database.
RUN node apps/cli/dist/index.js --help > /dev/null \
  && node apps/cli/dist/index.js config --help > /dev/null

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
# The bundled CLI plus the native drivers it needs at runtime. tsup inlines
# every pure-JS dependency (commander, drizzle-orm, @netpro/*) into
# dist/index.js and marks only better-sqlite3 and pg as external, because
# those two cannot be bundled: better-sqlite3 is a native addon, and pg is
# CommonJS that resolves its backends dynamically. Only they need to exist in
# node_modules for `netpro migrate` to run in this image.
#
# Keep this list in sync with `external` in apps/cli/tsup.config.ts. An earlier
# revision left commander and drizzle-orm unbundled but never copied them here,
# so the image built fine and then died at runtime with ERR_MODULE_NOT_FOUND.
# apps/cli/src/bundle.test.ts now asserts both ends of that contract.
COPY --from=builder /app/apps/cli/dist ./apps/cli/dist
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# bindings and file-uri-to-path are better-sqlite3's own runtime requires.
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=builder /app/node_modules/pg ./node_modules/pg
# Next.js's standalone output already places the workspace packages (and the
# committed migration SQL) at /app/packages/db, which is one of the resolver's
# candidate paths, so no extra copy of the migrations is needed here.

USER netpro
EXPOSE 3000

# 127.0.0.1, not localhost: inside this Alpine container "localhost" resolves
# to ::1 (IPv6) first, but Next.js's standalone server only binds the IPv4
# 0.0.0.0 — wget against "localhost" reliably gets "Connection refused" even
# though the server is up and answering fine on 127.0.0.1. Verified directly
# with `docker exec ... wget http://localhost:3000/...` (fails) vs
# `wget http://127.0.0.1:3000/...` (succeeds) against a running container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "apps/web/server.js"]
