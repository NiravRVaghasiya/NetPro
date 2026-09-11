#!/usr/bin/env bash
#
# CLI smoke test (Phase 21): the shipped netpro CLI as real processes over a
# scratch SQLite install.
#
#   netpro --help          command surface (init / serve / ...)
#   netpro init            identity + config + 0600 token + SQLite migrations
#   netpro init            idempotent re-run (config byte-identical)
#   netpro migrate --status / netpro migrate
#   netpro serve           the CLI starts the long-lived server ...
#   netpro status          ... and the CLI observes its /api/health
#   SIGTERM                graceful shutdown
#
# The HTTP/API/SSE surface exercised while `serve` runs is covered by the
# server smoke (local-stack.sh), which runs against both SQLite and
# PostgreSQL.
#
# Environment:
#   none required. NETPRO_HOME and every data path live under a scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_node
require_curl
require_file "$CLI" "Build the CLI first: npm run build -w @netpro/cli"

WORK="$(make_scratch)"
export NETPRO_HOME="$WORK/home"
mkdir -p "$NETPRO_HOME"
trap 'cleanup_pids; rm -rf "$WORK"' EXIT INT TERM

cli() {
  node "$CLI" "$@"
}

step 'CLI command surface: --help exposes init and serve'
cli --help >"$WORK/help.txt" 2>&1
assert_contains "$WORK/help.txt" 'init' 'netpro --help does not document init'
assert_contains "$WORK/help.txt" 'serve' 'netpro --help does not document serve'

step 'netpro init creates an install (identity, config, token, SQLite database)'
cli init --owner 'Smoke Test' --email 'smoke@example.com' >"$WORK/init1.txt"
cat "$WORK/init1.txt" | sed 's/^/    /'
assert_contains "$WORK/init1.txt" 'NetPro initialized'
assert_contains "$WORK/init1.txt" 'Database: SQLite'
assert_contains "$WORK/init1.txt" '15/15 migrations applied'
assert_contains "$WORK/init1.txt" 'Identity: ins_'
[ -f "$NETPRO_HOME/config.toml" ] || die 'config.toml missing'
[ -f "$NETPRO_HOME/netpro.db" ] || die 'SQLite database file missing'
[ -f "$NETPRO_HOME/keys/access-token" ] || die 'access token missing'
perms="$(stat -c '%a' "$NETPRO_HOME/keys/access-token" 2>/dev/null || stat -f '%Lp' "$NETPRO_HOME/keys/access-token")"
[ "$perms" = '600' ] || die "access token must be mode 0600, got $perms"
cp "$NETPRO_HOME/config.toml" "$WORK/config-before.toml"

step 'netpro init is idempotent (config kept byte-for-byte, no rewrites)'
cli init >"$WORK/init2.txt"
assert_contains "$WORK/init2.txt" 'kept existing' 'second init must keep the existing config'
assert_contains "$WORK/init2.txt" '15/15 migrations applied'
cmp -s "$WORK/config-before.toml" "$NETPRO_HOME/config.toml" || die 'second init rewrote config.toml'

step 'netpro migrate --status and netpro migrate'
cli migrate --status >"$WORK/status-db.txt"
assert_contains "$WORK/status-db.txt" 'Applied:  15/15'
assert_contains "$WORK/status-db.txt" 'Pending:  0'
cli migrate >"$WORK/migrate.txt"
assert_contains "$WORK/migrate.txt" 'already up to date'

step 'netpro backup snapshots the database and --list inventories it (Phase 22)'
cli backup >"$WORK/backup.txt"
cat "$WORK/backup.txt" | sed 's/^/    /'
assert_contains "$WORK/backup.txt" 'Backed up SQLite' 'netpro backup did not snapshot SQLite'
BACKUP_FILE="$(ls -t "$NETPRO_HOME/backups"/netpro-*.db | head -1)"
[ -f "$BACKUP_FILE" ] || die 'timestamped backup file missing'
perms="$(stat -c '%a' "$BACKUP_FILE" 2>/dev/null || stat -f '%Lp' "$BACKUP_FILE")"
[ "$perms" = '600' ] || die "backup must be mode 0600, got $perms"
cli backup --list >"$WORK/backups.txt"
assert_contains "$WORK/backups.txt" "$(basename "$BACKUP_FILE")" 'backup --list does not inventory the snapshot'

step 'netpro restore round-trips with a pre-restore safety copy (Phase 22)'
cli restore "$BACKUP_FILE" >"$WORK/restore.txt"
cat "$WORK/restore.txt" | sed 's/^/    /'
assert_contains "$WORK/restore.txt" 'Restored SQLite'
assert_contains "$WORK/restore.txt" '15/15 migrations applied'
ls "$NETPRO_HOME/backups"/pre-restore-*.db >/dev/null || die 'pre-restore safety copy missing'
cli migrate --status >"$WORK/status-db2.txt"
assert_contains "$WORK/status-db2.txt" 'Applied:  15/15'

step 'netpro serve starts the server from the CLI'
PORT="$(get_free_port)"
node "$CLI" serve --host 127.0.0.1 --port "$PORT" >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
track_pid "$SERVE_PID"
wait_for_http "http://127.0.0.1:$PORT/api/health" 30

step 'netpro status observes the running server'
NETPRO_URL="http://127.0.0.1:$PORT" cli status >"$WORK/status.txt" 2>&1
sed 's/^/    /' "$WORK/status.txt"
assert_contains "$WORK/status.txt" 'running'
assert_contains "$WORK/status.txt" 'healthy'
assert_contains "$WORK/status.txt" 'sqlite'

step 'SIGTERM shuts the CLI-managed server down gracefully'
kill -TERM "$SERVE_PID"
wait_for_exit "$SERVE_PID" 10
untrack_pid "$SERVE_PID"
if grep -qiE 'unhandled|uncaught|EADDRINUSE' "$WORK/serve.log"; then
  cat "$WORK/serve.log"
  die 'server logged an error'
fi

ok 'cli smoke passed (sqlite)'
