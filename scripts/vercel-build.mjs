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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Vercel may invoke the build command from the framework-detected app
// directory (e.g. apps/web) rather than the repository root. All paths in
// this script (workspace flags, migration binaries, turbo filters) assume
// the repo root, so chdir there up front.
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
  // Use npx to ensure the binary is found regardless of PATH setup.
  const built = run('npx', ['tsup'], { cwd: 'apps/cli' });
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
process.exit(run('npx', ['turbo', 'run', 'build', '--filter=@netpro/web']));
