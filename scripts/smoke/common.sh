# shellcheck shell=bash
# Shared helpers for the Phase 21 end-to-end smoke scripts.
#
# These smokes exercise the *shipped artifacts* (built CLI bundle, standalone
# server bin, standalone Next.js output) as real OS processes over real HTTP —
# the layer vitest cannot cover: tsup externals, shipped migration SQL,
# standalone tracing, and the exact loopback/SSE behaviour a user gets from
# `netpro init` + `netpro serve`.
#
# Every script is hermetic: NETPRO_HOME points at a scratch directory and
# servers bind 127.0.0.1 on an ephemeral port, so running them needs no cloud,
# no credentials, and nothing on the developer's real ~/.netpro.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/apps/cli/dist/index.js"
SERVER_BIN="$REPO_ROOT/packages/server/dist/bin.js"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''; C_OFF=''
fi

SMOKE_PIDS=()

step() { printf '%s▶%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

require_file() {
  [ -f "$1" ] || die "missing $1 — build it first (npm run build)"
}

require_curl() {
  command -v curl >/dev/null 2>&1 || die 'curl is required by the smoke scripts'
}

make_scratch() {
  mktemp -d "${TMPDIR:-/tmp}/netpro-smoke.XXXXXX"
}

require_node() {
  command -v node >/dev/null 2>&1 || die 'node is required by the smoke scripts'
}

# Reserve and immediately release an ephemeral loopback port (prints it).
get_free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})"
}

track_pid() {
  SMOKE_PIDS+=("$1")
}

untrack_pid() {
  local want="$1" pid
  local next=()
  for pid in "${SMOKE_PIDS[@]:-}"; do
    [ "$pid" = "$want" ] || next+=("$pid")
  done
  SMOKE_PIDS=("${next[@]}")
}

# Wait for a tracked process to exit (used after a graceful SIGTERM).
wait_for_exit() {
  local pid="$1" seconds="${2:-10}" i
  for ((i = 0; i < seconds * 5; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  return 1
}

# grep a file for an extended regex; fail the smoke with a clear message.
#   assert_contains <file> <pattern> [message]
assert_contains() {
  local file="$1" pattern="$2"
  local message="${3:-expected /$pattern/ in $file}"
  grep -Eq "$pattern" "$file" || die "$message"
}

cleanup_pids() {
  local pid
  for pid in "${SMOKE_PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

# Silence shellcheck for arrays on bash 3: guard expansion with :- as above.
register_cleanup() {
  trap 'cleanup_pids' EXIT INT TERM
}

# Start the CLI/server in the background and capture its log.
#   start_server <name> <logfile> -- <command args...>
# Exports SERVER_PID after launch.
start_server() {
  local name="$1"; shift
  local logfile="$1"; shift
  [ "$1" = "--" ] && shift
  step "Starting $name (log: $logfile)"
  "$@" >"$logfile" 2>&1 &
  SERVER_PID=$!
  SMOKE_PIDS+=("$SERVER_PID")
}

# Poll a URL until it answers 2xx or the timeout elapses.
#   wait_for_http <url> [seconds]
wait_for_http() {
  local url="$1"
  local seconds="${2:-25}"
  local i
  for ((i = 0; i < seconds; i++)); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "${SERVER_PID:-0}" 2>/dev/null; then
      echo "---- server log ----" >&2
      cat "${SERVER_LOG:-/dev/null}" >&2 || true
      die 'server process exited before becoming ready'
    fi
    sleep 1
  done
  echo "---- server log ----" >&2
  cat "${SERVER_LOG:-/dev/null}" >&2 || true
  die "timed out waiting for $url"
}

# Body of an HTTP response on stdout, asserting the status code.
#   expect_http <method> <url> <expected_status> [curl-extra-args...]
expect_http() {
  local method="$1" url="$2" expected="$3"; shift 3
  local code
  code="$(curl -s -o /tmp/netpro-smoke-body.$$ -w '%{http_code}' -X "$method" "$@" "$url")"
  [ "$code" = "$expected" ] || {
    echo "---- response body ----" >&2
    cat /tmp/netpro-smoke-body.$$ >&2 || true
    die "$method $url expected $expected, got $code"
  }
  cat /tmp/netpro-smoke-body.$$
  rm -f /tmp/netpro-smoke-body.$$
}

# JSON field lookup without a jq dependency (values are flat in our responses).
json_grep() {
  # json_grep <file> <literal-key>  → matches "key":<value>; used with grep -q
  local file="$1" key="$2"
  grep -q "\"$key\"[[:space:]]*:" "$file"
}
