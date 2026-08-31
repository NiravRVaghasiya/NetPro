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
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

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
