# NOTE: the plan brief for this task specified `node:20-alpine` for all three
# stages (matching the root package.json `engines.node: >=20` and the Node 20
# pin planned for CI). That does not work here: @netpro/db's dependency
# better-sqlite3@13.0.3 declares `engines.node: >=22`. It still compiles
# against Node 20 headers via node-gyp without error, but the resulting native
# addon segfaults (SIGSEGV) as soon as it is loaded — which happens
# unconditionally, because packages/db/src/index.ts does a static top-level
# `import Database from 'better-sqlite3'` regardless of DB_DIALECT. This
# reproduced identically under both Turbopack and webpack, confirming it is a
# Node/V8 ABI mismatch, not a bundler issue — and confirmed fixed by switching
# to node:22-alpine, which is what the following FROM lines use. See the
# task-13 report for the full investigation; this is worth reconciling with
# the workspace-wide Node 20 pin in a follow-up (bump to >=22 everywhere, or
# pin better-sqlite3 to a Node-20-compatible version).

# ── Stage 1: Dependencies ──
FROM node:22-alpine AS deps
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
FROM node:22-alpine AS builder
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
FROM node:22-alpine AS runner
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
