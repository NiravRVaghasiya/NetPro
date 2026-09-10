#!/usr/bin/env node
// Vercel build step: migrate the managed database, then build the web app.
//
// Why migrate at build time rather than on cold start? A Vercel deployment
// starts many serverless instances concurrently, and each one would otherwise
// race to apply the same DDL. NetPro's runner now serializes that with a
// Postgres advisory lock so it is *safe* either way, but doing it once here is
// still better: it happens before any traffic, a failure fails the deploy
// instead of returning 500s to users, and request paths stay free of DDL.
//
// This script is deliberately forgiving about one case: the very first deploy,
// where a database may not be attached yet (the Vercel Postgres integration
// can provision DATABASE_URL after the initial build). Then it skips
// migration with a clear warning and lets the startup hook handle it — safely,
// thanks to the advisory lock. Any other migration failure fails the build.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Vercel may invoke the build command from the framework-detected app
// directory (e.g. apps/web) rather than the repository root. All paths in
// this script (workspace flags, migration binaries, turbo filters) assume
// the repo root, so chdir there up front.
//
// `npm run vercel-build` is defined in *both* package.json files for exactly
// this reason: Vercel prefers a `vercel-build` script over the framework
// default, and it runs it from whichever directory it decided the app lives
// in (repo root or apps/web). Both entry points land here.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    cwd: options.cwd || process.cwd(),
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Prefer the turbo binary npm installed at the repo root; `npx turbo` would
// silently fetch (and run) a different turbo from the registry if the local
// one were ever missing — a slow failure that is hard to read in a log. If
// turbo is genuinely absent, fall back to the plain workspace order below.
const localTurbo = resolve(repoRoot, 'node_modules', '.bin', 'turbo');

const dialect = process.env.DB_DIALECT ?? 'postgresql';
const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

if (dialect === 'postgresql' && !hasDatabase) {
  console.warn(
    '\n[vercel-build] DATABASE_URL is not set — skipping the build-time migration.\n' +
      '[vercel-build] Attach a Postgres database (Vercel Postgres, Neon, or Supabase)\n' +
      '[vercel-build] and redeploy. The app will migrate on first boot in the meantime.\n'
  );
} else {
  console.log('[vercel-build] Applying database migrations...');
  // Build the CLI first: `netpro migrate` is the same code path operators run
  // locally and in Docker, so the deploy step cannot drift from it.
  const built = run('npm', ['run', 'build', '-w', '@netpro/cli']);
  if (built !== 0) process.exit(built);

  const migrated = run('node', ['apps/cli/dist/index.js', 'migrate'], {
    env: { DB_DIALECT: dialect },
  });
  if (migrated !== 0) {
    console.error('[vercel-build] Migration failed — aborting the deployment.');
    process.exit(migrated);
  }
}

console.log('[vercel-build] Building the web application...');
if (existsSync(localTurbo)) {
  process.exit(
    run(process.execPath, [localTurbo, 'run', 'build', '--filter=@netpro/web'])
  );
}

// No turbo (turbo is a root devDependency, so this means the install step
// changed). Build the dependency chain by hand instead of failing: the
// packages are consumed as source via next.config `transpilePackages`, so
// their `build` is a typecheck that must pass before the web build runs.
console.warn(
  '[vercel-build] turbo not found at node_modules/.bin/turbo — building workspaces directly.'
);
for (const workspace of ['@netpro/core', '@netpro/db', '@netpro/config']) {
  const status = run('npm', ['run', 'build', '-w', workspace, '--if-present']);
  if (status !== 0) process.exit(status);
}
process.exit(run('npm', ['run', 'build', '-w', '@netpro/web']));
