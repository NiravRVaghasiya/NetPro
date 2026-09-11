#!/usr/bin/env bash
#
# Phase 21/24 — Web UI smoke against the production standalone build.
#
# Stages apps/web/.next/standalone exactly like the Docker runner stage
# (server.js + traced node_modules + static + public), starts it on
# 127.0.0.1 with a scratch SQLite install, and asserts the Phase 24 contract:
#
#   • the landing page loads and is the local-first on-ramp
#   • /login is gone (Auth.js flows removed in Phase 24)
#   • the Web UI has no /api/* routes of its own — it is a pure client of the
#     standalone @netpro/server (the server smoke covers /api/health)
#   • the private Observatory renders as a client shell (server-driven data)
#   • production security headers are present
#
# Requires a full build first:  npm run build -w apps/web && npm run build -w @netpro/cli

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_curl
require_file "$CLI"
STANDALONE="$REPO_ROOT/apps/web/.next/standalone"
[ -f "$STANDALONE/apps/web/server.js" ] || die "missing $STANDALONE — build it first (npm run build -w apps/web)"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/netpro-web-smoke.XXXXXX")"
export NETPRO_HOME="$WORKDIR/home"
WEB_LOG="$WORKDIR/web.log"
mkdir -p "$NETPRO_HOME"
trap 'cleanup_pids; rm -rf "$WORKDIR"' EXIT INT TERM

assert_contains() {
  local file="$1" pattern="$2"
  local message="${3:-expected /$pattern/ in $file}"
  grep -Eq "$pattern" "$file" || die "$message"
}

# Migrate the scratch SQLite database the CLI uses (the Web UI itself no
# longer opens a database — Phase 24 — but the CLI still proves the install
# works end to end).
step 'init scratch install for the CLI'
node "$CLI" init >"$WORKDIR/init.txt"
assert_contains "$WORKDIR/init.txt" 'NetPro initialized'

# Mirror the Dockerfile runner layout: static assets and public/ live next to
# the standalone server.js output. Clear any previous staging first so repeat
# runs never nest static/static.
step 'stage standalone build (server.js + static + public)'
rm -rf "$STANDALONE/apps/web/.next/static" "$STANDALONE/apps/web/public"
mkdir -p "$STANDALONE/apps/web/.next"
cp -a "$REPO_ROOT/apps/web/.next/static" "$STANDALONE/apps/web/.next/static"
cp -a "$REPO_ROOT/apps/web/public" "$STANDALONE/apps/web/public"

# Pick a free loopback port the way a careful operator would (no fixed ports).
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})")"
BASE="http://127.0.0.1:$PORT"

step "starting standalone Next.js server on $BASE"
(
  cd "$STANDALONE"
  HOSTNAME=127.0.0.1 PORT="$PORT" NODE_ENV=production \
    node apps/web/server.js
) >"$WEB_LOG" 2>&1 &
SERVER_PID=$!
SMOKE_PIDS+=("$SERVER_PID")
SERVER_LOG="$WEB_LOG"

wait_for_http "$BASE/"
ok 'web server is listening'
sed 's/^/    /' "$WEB_LOG" | tail -8

step 'landing page loads (Web UI loading)'
curl -s "$BASE/" -D "$WORKDIR/landing.headers" -o "$WORKDIR/landing.html"
head -1 "$WORKDIR/landing.headers" | grep -qi 'HTTP/.*200' || die 'landing page did not return 200'
assert_contains "$WORKDIR/landing.html" '<title>NetPro'
assert_contains "$WORKDIR/landing.html" 'Private\. Local\. Searchable\.'
grep -qi 'content-security-policy' "$WORKDIR/landing.headers" || die 'CSP header missing'
grep -qi 'x-content-type-options: nosniff' "$WORKDIR/landing.headers" || die 'nosniff header missing'
ok 'landing page renders with production security headers'

step '/login is gone (Auth.js removed in Phase 24)'
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login")"
[ "$code" = '404' ] || die "/login expected 404 (Auth.js flows removed), got $code"
ok '/login returns 404'

step 'the Web UI has no /api routes of its own (pure client)'
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
[ "$code" = '404' ] || die "/api/health expected 404 (no duplicated API surface), got $code"
ok '/api/health returns 404 — the server owns the API'

step 'Observatory renders as a client shell'
code="$(curl -s -o "$WORKDIR/obs.html" -w '%{http_code}' "$BASE/observatory")"
[ "$code" = '200' ] || die "/observatory expected 200, got $code"
assert_contains "$WORKDIR/obs.html" 'Observatory|NetPro'
ok 'Observatory page loads (server-driven data)'

step 'static Next assets are served'
asset="$(grep -oE '/_next/static/[^"]+\.js' "$WORKDIR/landing.html" | head -1)"
[ -n "$asset" ] || die 'no /_next/static script found in landing HTML'
curl -fsS "$BASE$asset" -o /dev/null || die "static asset $asset did not load"
ok "static asset loads ($asset)"

step 'SIGTERM shuts the UI down'
kill -TERM "$SERVER_PID"
for _ in $(seq 1 15); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$SERVER_PID" 2>/dev/null; then kill -KILL "$SERVER_PID"; die 'web server did not stop'; fi
ok 'web server stopped cleanly'
SMOKE_PIDS=()

printf '\n%s%s web-ui smoke passed%s\n' "$C_GREEN$C_BOLD" '✓' "$C_OFF"
