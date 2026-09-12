#!/usr/bin/env bash
#
# Phase 21 — CLI + server smoke over real processes and real HTTP.
#
# Exercises the exact flow from the plan on a scratch install:
#
#   netpro init  →  netpro serve  →  /api/health  →  API calls  →  SSE
#
# and proves both supported databases start from the same artifacts:
#
#   SMOKE_DIALECT=sqlite       (default — zero external services)
#   SMOKE_DIALECT=postgresql   (needs DATABASE_URL pointing at a server)
#
# What it asserts (every named check in the Phase 21 list except Web UI):
#   • netpro init creates the install, identity, token, and migrates
#   • netpro init is idempotent (config kept, migrations no-op)
#   • netpro serve binds 127.0.0.1, prints the Phase 2 banner (naming the bound
#     address as the API + built-in console, never as the Web UI), shuts down
#   • /api/health is healthy and names the dialect (SQLite/PG startup)
#   • core API calls answer: contacts, search, graph, jobs, settings, providers
#   • POST /api/scan creates an observable job
#   • the SSE event stream delivers search.* events live
#   • the built-in console page at / loads
#   • a non-loopback caller is rejected (Phase 5 auth boundary)
#   • `netpro status` sees the running server
#
# Usage:
#   scripts/smoke/local-stack.sh
#   SMOKE_DIALECT=postgresql DATABASE_URL=postgres://... scripts/smoke/local-stack.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

DIALECT="${SMOKE_DIALECT:-sqlite}"
EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-15}"

require_curl
require_file "$CLI"
[ -f "$SERVER_BIN" ] || die "missing $SERVER_BIN — build it first (npm run build)"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/netpro-local-smoke.XXXXXX")"
export NETPRO_HOME="$WORKDIR/home"
SERVER_LOG="$WORKDIR/server.log"
SSE_LOG="$WORKDIR/sse.out"
mkdir -p "$NETPRO_HOME"
trap 'cleanup_pids; rm -rf "$WORKDIR"' EXIT INT TERM

cli() { node "$CLI" "$@"; }

case "$DIALECT" in
  sqlite)
    HEALTH_DIALECT='sqlite'
    DB_LABEL='SQLite'
    ;;
  postgresql)
    HEALTH_DIALECT='postgresql'
    DB_LABEL='PostgreSQL'
    export DB_DIALECT='postgresql'
    : "${DATABASE_URL:?SMOKE_DIALECT=postgresql requires DATABASE_URL}"
    ;;
  *) die "unknown SMOKE_DIALECT: $DIALECT" ;;
esac

assert_contains() {
  local file="$1" pattern="$2"
  local message="${3:-expected /$pattern/ in $file}"
  grep -Eq "$pattern" "$file" || die "$message"
}

assert_not_contains() {
  local file="$1" pattern="$2"
  local message="${3:-expected NO /$pattern/ in $file}"
  grep -Eq "$pattern" "$file" && die "$message"
  return 0
}

# ── 0. The CLI bundle loads and exposes its command tree ─────────────────
step 'CLI bundle: --help lists init and serve'
cli --help >"$WORKDIR/help.txt"
assert_contains "$WORKDIR/help.txt" 'init' 'init command missing from --help'
assert_contains "$WORKDIR/help.txt" 'serve' 'serve command missing from --help'
ok 'CLI bundle loads with the local-first commands'

# ── 1. netpro init ───────────────────────────────────────────────────────
step "netpro init ($DIALECT)"
cli init --owner "Smoke Test" --email "smoke@example.com" >"$WORKDIR/init1.txt"
cat "$WORKDIR/init1.txt" | sed 's/^/    /'
assert_contains "$WORKDIR/init1.txt" 'NetPro initialized'
assert_contains "$WORKDIR/init1.txt" "Database: $DB_LABEL"
assert_contains "$WORKDIR/init1.txt" "$EXPECTED_MIGRATIONS/$EXPECTED_MIGRATIONS migrations applied"
assert_contains "$WORKDIR/init1.txt" 'Identity: ins_'
[ -f "$NETPRO_HOME/config.toml" ] || die 'config.toml was not written'
[ -f "$NETPRO_HOME/keys/access-token" ] || die 'access token was not minted'
if command -v stat >/dev/null 2>&1 && stat -c '%a' "$NETPRO_HOME/keys/access-token" 2>/dev/null | grep -q '^600$'; then
  ok 'access token is stored mode 0600'
fi
if [ "$DIALECT" = 'sqlite' ]; then
  [ -f "$NETPRO_HOME/netpro.db" ] || die 'SQLite database file was not created'
fi
ok 'init created the install, identity, token, and migrated the database'

step 'netpro init is idempotent'
cli init >"$WORKDIR/init2.txt"
assert_contains "$WORKDIR/init2.txt" 'kept existing' 'second init must keep the existing config'
assert_contains "$WORKDIR/init2.txt" "$EXPECTED_MIGRATIONS/$EXPECTED_MIGRATIONS migrations applied"
ok 're-running init keeps the config and re-applies no migrations'

# ── 2. netpro serve on an ephemeral loopback port ────────────────────────
step 'netpro serve (127.0.0.1, ephemeral port)'
node "$CLI" serve --host 127.0.0.1 --port 0 >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
SMOKE_PIDS+=("$SERVER_PID")

PORT=''
for _ in $(seq 1 25); do
  PORT="$(sed -nE 's/^Local:[[:space:]]+https?:\/\/[^: ]*:([0-9]+).*/\1/p' "$SERVER_LOG" | head -1)"
  [ -n "$PORT" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || die 'serve exited during startup (see server log)'
  sleep 0.5
done
[ -n "$PORT" ] || { cat "$SERVER_LOG"; die 'could not read bound port from serve banner'; }
BASE="http://127.0.0.1:$PORT"
ok "server listening on $BASE"
sed 's/^/    /' "$SERVER_LOG"

wait_for_http "$BASE/api/health"
assert_contains "$SERVER_LOG" 'Auth:     local' 'banner must name the local auth policy'
# This port serves the API and the built-in console, not the Web UI — the Web
# UI is the separate apps/web client on its own port. The banner used to print
# the server's own URL on both lines; it must never claim that again.
assert_contains "$SERVER_LOG" "Local:    http://127\.0\.0\.1:$PORT  \(API \+ built-in console\)" \
  'banner must label the bound address as the API + built-in console'
assert_contains "$SERVER_LOG" 'Web UI:   not running' \
  'with no NETPRO_WEB_URL configured the banner must say the Web UI is not running'
assert_not_contains "$SERVER_LOG" "Web UI:   http://127\.0\.0\.1:$PORT" \
  'banner must not advertise the API port as the Web UI'

# ── 3. Health and SQLite/PostgreSQL startup ──────────────────────────────
step 'GET /api/health'
curl -fsS "$BASE/api/health" >"$WORKDIR/health.json"
cat "$WORKDIR/health.json" | sed 's/^/    /'
assert_contains "$WORKDIR/health.json" '"status":"healthy"'
assert_contains "$WORKDIR/health.json" "\"dialect\":\"$HEALTH_DIALECT\""
ok "health reports healthy on $DIALECT"

step 'GET /api/health?verbose=1 (migration + search detail, trusted loopback)'
curl -fsS "$BASE/api/health?verbose=1" >"$WORKDIR/health-v.json"
assert_contains "$WORKDIR/health-v.json" "\"applied\":$EXPECTED_MIGRATIONS"
assert_contains "$WORKDIR/health-v.json" '"search"'
ok 'all migrations are applied and search capability is reported'

step 'GET /api/server-info'
curl -fsS "$BASE/api/server-info" >"$WORKDIR/info.json"
assert_contains "$WORKDIR/info.json" '"name":"NetPro"'

# ── 4. API calls ─────────────────────────────────────────────────────────
step 'API calls over the stable Web API'
for path in /api/contacts /api/jobs /api/settings /api/providers "/api/search?q=smoke" /api/graph; do
  curl -fsS "$BASE$path" >"$WORKDIR/api.out" || die "GET $path failed"
  info "  $path → $(head -c 120 "$WORKDIR/api.out")"
done
assert_contains "$WORKDIR/api.out" '"nodes"'

step 'POST /api/scan creates an observable job'
curl -fsS -X POST "$BASE/api/scan" >"$WORKDIR/scan.json"
cat "$WORKDIR/scan.json" | head -c 240 | sed 's/^/    /'; echo
assert_contains "$WORKDIR/scan.json" '"job"'
assert_contains "$WORKDIR/scan.json" '"type":"scan"'
SCAN_JOB="$(sed -nE 's/.*"job":\{"id":"([^"]+)".*/\1/p' "$WORKDIR/scan.json" | head -1)"
[ -n "$SCAN_JOB" ] && curl -fsS "$BASE/api/jobs/$SCAN_JOB" >"$WORKDIR/job.json" \
  && assert_contains "$WORKDIR/job.json" '"id"'
ok 'scan job is fetchable through /api/jobs/:id'

# ── 5. Server-Sent Events ────────────────────────────────────────────────
step 'SSE: GET /api/events/stream streams live search events'
curl -sN --max-time 10 -H 'Accept: text/event-stream' "$BASE/api/events/stream" >"$SSE_LOG" 2>&1 &
SSE_PID=$!
SMOKE_PIDS+=("$SSE_PID")
sleep 1
curl -fsS "$BASE/api/search?q=sse-probe" >/dev/null
wait "$SSE_PID" 2>/dev/null || true
head -12 "$SSE_LOG" | sed 's/^/    /'
assert_contains "$SSE_LOG" 'retry: 3000'
assert_contains "$SSE_LOG" 'event: search.started'
assert_contains "$SSE_LOG" 'event: search.completed'
assert_contains "$SSE_LOG" 'data: '
ok 'SSE delivered search.started/search.completed over text/event-stream'

# ── 6. Built-in console page ─────────────────────────────────────────────
step 'GET / serves the local console (Web UI loading)'
curl -fsS "$BASE/" >"$WORKDIR/home.html"
assert_contains "$WORKDIR/home.html" '<title>NetPro'
assert_contains "$WORKDIR/home.html" '<!doctype html>'
ok 'the built-in local console renders'

# ── 6b. Phase 23 response hardening + install file modes ─────────────────
step 'security headers, console CSP, and the loopback-only CORS default (Phase 23)'
# Header field names are case-insensitive on the wire (HTTP/1 keeps the
# server's case, HTTP/2 lowercases), so match them case-insensitively.
assert_header() {
  local file="$1" pattern="$2"
  local message="${3:-expected header /$pattern/ in $file}"
  grep -qiE "$pattern" "$file" || die "$message"
}
curl -s -D "$WORKDIR/health.hdr" -o /dev/null "$BASE/api/health"
assert_header "$WORKDIR/health.hdr" 'x-content-type-options: nosniff'
assert_header "$WORKDIR/health.hdr" 'x-frame-options: DENY'
assert_header "$WORKDIR/health.hdr" 'referrer-policy: no-referrer'
grep -qi 'strict-transport-security' "$WORKDIR/health.hdr" && die 'HSTS must stay off without NETPRO_HSTS'
curl -s -D "$WORKDIR/home.hdr" -o /dev/null "$BASE/"
assert_header "$WORKDIR/home.hdr" "content-security-policy: default-src 'none'"
# Authenticated loopback browser origin is granted; an internet origin is not.
curl -s -D "$WORKDIR/cors-ok.hdr" -o /dev/null -H 'Origin: http://localhost:3000' "$BASE/api/contacts"
assert_header "$WORKDIR/cors-ok.hdr" 'access-control-allow-origin: http://localhost:3000'
curl -s -D "$WORKDIR/cors-evil.hdr" -o /dev/null -H 'Origin: https://evil.example.com' "$BASE/api/contacts"
grep -qi 'access-control-allow-origin' "$WORKDIR/cors-evil.hdr" && die 'internet origin must get no CORS grant by default'
ok 'hardening headers, CSP, and CORS default hold over real HTTP'

step 'install directory and secrets are owner-only (Phase 23)'
home_mode="$(stat -c '%a' "$NETPRO_HOME" 2>/dev/null || stat -f '%Lp' "$NETPRO_HOME")"
[ "$home_mode" = '700' ] || die "NETPRO_HOME must be mode 0700, got $home_mode"
token_mode="$(stat -c '%a' "$NETPRO_HOME/keys/access-token" 2>/dev/null || stat -f '%Lp' "$NETPRO_HOME/keys/access-token")"
[ "$token_mode" = '600' ] || die "access token must be mode 0600, got $token_mode"
if [ "$DIALECT" = 'sqlite' ]; then
  db_mode="$(stat -c '%a' "$NETPRO_HOME/netpro.db" 2>/dev/null || stat -f '%Lp' "$NETPRO_HOME/netpro.db")"
  [ "$db_mode" = '600' ] || die "SQLite database must be mode 0600, got $db_mode"
fi
ok 'install directory is 0700 and secrets are 0600'

# ── 7. Phase 5 auth boundary ─────────────────────────────────────────────
step 'non-loopback / proxied caller is rejected in local auth mode'
# A proxied request is never "direct loopback" even when the socket peer is,
# so this has to answer 401 (same boundary the Docker e2e checks on the UI).
code="$(curl -s -o "$WORKDIR/remote.out" -w '%{http_code}' \
  -H 'X-Forwarded-For: 203.0.113.7' "$BASE/api/contacts")"
[ "$code" = '401' ] || { cat "$WORKDIR/remote.out"; die "proxied request expected 401, got $code"; }
# …and the same caller with the real access token gets back in.
TOKEN="$(cat "$NETPRO_HOME/keys/access-token")"
code="$(curl -s -o "$WORKDIR/remote-ok.out" -w '%{http_code}' \
  -H 'X-Forwarded-For: 203.0.113.7' -H "Authorization: Bearer $TOKEN" "$BASE/api/contacts")"
[ "$code" = '200' ] || { cat "$WORKDIR/remote-ok.out"; die "token-authenticated request expected 200, got $code"; }
ok 'proxied /api/contacts is 401 without the token and 200 with it'

# ── 8. netpro status sees the running server ─────────────────────────────
step 'netpro status probes the running server'
NETPRO_URL="$BASE" cli status >"$WORKDIR/status.txt"
sed 's/^/    /' "$WORKDIR/status.txt"
assert_contains "$WORKDIR/status.txt" 'running'
assert_contains "$WORKDIR/status.txt" 'healthy'
assert_contains "$WORKDIR/status.txt" "$HEALTH_DIALECT"
ok 'netpro status reports the server healthy'

# ── 9. Graceful shutdown ─────────────────────────────────────────────────
step 'SIGTERM shuts the server down gracefully'
kill -TERM "$SERVER_PID"
for _ in $(seq 1 15); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  die 'server did not shut down on SIGTERM'
fi
assert_contains "$SERVER_LOG" 'NetPro server stopped'
ok 'netpro serve stopped cleanly'
SMOKE_PIDS=()

# ── 10. The standalone @netpro/server bin (what Docker Compose runs) ──────
step 'standalone netpro-server bin starts and answers health'
SERVER2_LOG="$WORKDIR/server2.log"
# NETPRO_WEB_URL is display-only metadata: it must appear on the banner's
# Web UI line without changing what this process binds or serves.
NETPRO_WEB_URL='http://localhost:3000' \
  node "$SERVER_BIN" --host 127.0.0.1 --port 0 >"$SERVER2_LOG" 2>&1 &
SERVER_PID=$!
SMOKE_PIDS+=("$SERVER_PID")
PORT2=''
for _ in $(seq 1 25); do
  PORT2="$(sed -nE 's/^Local:[[:space:]]+https?:\/\/[^: ]*:([0-9]+).*/\1/p' "$SERVER2_LOG" | head -1)"
  [ -n "$PORT2" ] && break
  sleep 0.5
done
[ -n "$PORT2" ] || { cat "$SERVER2_LOG"; die 'standalone bin did not bind'; }
BASE2="http://127.0.0.1:$PORT2"
SERVER_LOG="$SERVER2_LOG"
wait_for_http "$BASE2/api/health"
curl -fsS "$BASE2/api/health" >"$WORKDIR/health2.json"
assert_contains "$WORKDIR/health2.json" "\"dialect\":\"$HEALTH_DIALECT\""
curl -fsS "$BASE2/api/contacts" >/dev/null
# A configured Web UI address is announced as such, and is never the bind.
assert_contains "$SERVER2_LOG" 'Web UI:   http://localhost:3000' \
  'a configured NETPRO_WEB_URL must appear on the banner'
assert_not_contains "$SERVER2_LOG" 'Web UI:   not running' \
  'the banner must not say "not running" when NETPRO_WEB_URL is set'
[ "$PORT2" != '3000' ] || die 'NETPRO_WEB_URL must not influence the bound port'
ok 'standalone netpro-server bin serves the API and names the configured Web UI'
kill -TERM "$SERVER_PID" 2>/dev/null || true

printf '\n%s%s local-stack smoke passed (%s)%s\n' "$C_GREEN$C_BOLD" '✓' "$DIALECT" "$C_OFF"
