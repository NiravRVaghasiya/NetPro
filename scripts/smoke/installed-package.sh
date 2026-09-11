#!/usr/bin/env bash
#
# Installed-package smoke: the release tarball, installed the way an operator
# installs it, running the way an operator runs it.
#
#   npm pack                       → the artifact the release publishes
#   npm install -g --prefix <tmp>  → the same bytes a user gets
#   netpro --version / init / migrate --status / status
#
# WHY THIS EXISTS. Every other smoke runs the CLI from a checkout, where
# `@netpro/db` resolves through node_modules and `packages/db/migrations` is
# simply where the repo keeps it. Neither is true once the package is unpacked
# into a global prefix. The v3.0.0 release shipped a tarball whose installed CLI
# could not locate its own migrations — the in-repo smokes passed, the tarball
# contained every migration file, and `netpro init` still failed on a user's
# machine. This smoke closes that gap: it asserts the packaged layout resolves
# migrations and can create a real database.
#
# Usage:
#   scripts/smoke/installed-package.sh [tarball]
#
# With no argument it packs the workspace first; the release workflow passes the
# exact tarball it is about to publish, so the artifact is never verified by a
# different code path than the one that ships.
#
# Environment:
#   none required. The install prefix and NETPRO_HOME live under a scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_node
command -v npm >/dev/null 2>&1 || die 'npm is required by the installed-package smoke'

WORK="$(make_scratch)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TARBALL="${1:-}"

if [ -z "$TARBALL" ]; then
  step 'Pack the workspace (the artifact a release publishes)'
  # `npm pack` runs prepack → builds the CLI and runs the package check, so
  # this packs exactly what a release would.
  npm pack --pack-destination "$WORK" >"$WORK/pack.log" 2>&1 \
    || { cat "$WORK/pack.log" >&2; die 'npm pack failed'; }

  VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
  TARBALL="$WORK/netpro-$VERSION.tgz"
  [ -f "$TARBALL" ] || { ls -la "$WORK" >&2; die "npm pack produced no netpro-$VERSION.tgz"; }
else
  TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
  require_file "$TARBALL"
fi

# The version the tarball claims, so `--version` is checked against the artifact
# rather than against the checkout that built it.
VERSION="$(tar xzOf "$TARBALL" package/package.json | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => console.log(JSON.parse(raw).version));
')"

info "tarball: $TARBALL"
info "version: $VERSION"

step 'Install it globally into a scratch prefix'
PREFIX="$WORK/prefix"
npm install -g --prefix "$PREFIX" "$TARBALL" >"$WORK/install.log" 2>&1 \
  || { tail -40 "$WORK/install.log" >&2; die 'npm install -g failed for the release tarball'; }

NETPRO="$PREFIX/bin/netpro"
require_file "$NETPRO"
ok "installed $NETPRO"

export NETPRO_HOME="$WORK/home"
export PATH="$PREFIX/bin:$PATH"

# Run from a directory that contains no packages/db and no node_modules of its
# own. The resolver also looks relative to the working directory, so running
# from the checkout lets the repo's own migrations satisfy a package that ships
# none — which is precisely how the v3.0.0 tarball passed every check while
# being unable to run on a user's machine.
cd "$WORK"

step 'The installed binary reports the packaged version'
netpro --version >"$WORK/version.txt" 2>&1 || { cat "$WORK/version.txt" >&2; die 'netpro --version failed'; }
assert_contains "$WORK/version.txt" "^${VERSION}$" "netpro --version did not report $VERSION"
ok "netpro --version → $VERSION"

step 'A globally installed CLI can locate its migrations and create the database'
netpro init >"$WORK/init.log" 2>&1 || { cat "$WORK/init.log" >&2; die 'netpro init failed from the installed package'; }
assert_contains "$WORK/init.log" "[0-9]+/[0-9]+ migrations applied" 'init did not apply migrations'
assert_contains "$WORK/init.log" "Identity:" 'init did not create an installation identity'
ok "netpro init applied the shipped migrations"

step 'The migrated database agrees with the shipped journal'
netpro migrate --status >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log" >&2; die 'netpro migrate --status failed'; }
assert_contains "$WORK/migrate.log" "Pending:[[:space:]]+0" 'pending migrations remain after init'
ok "$(grep -E 'Applied:' "$WORK/migrate.log" | head -1 | tr -s ' ')"

step 'netpro status reads the install it just created'
netpro status >"$WORK/status.log" 2>&1 || { cat "$WORK/status.log" >&2; die 'netpro status failed'; }
assert_contains "$WORK/status.log" "Database:.*sqlite.*[0-9]+/[0-9]+ migrations" 'status did not report a migrated database'
ok "netpro status reported a migrated install"

ok 'installed-package smoke passed'
