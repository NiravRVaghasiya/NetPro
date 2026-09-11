#!/usr/bin/env node

/**
 * Verify the files that make the published `netpro` package runnable.
 *
 * The repository is a workspace, but the package installed by an operator is
 * deliberately small: the CLI is bundled by tsup and only native database
 * drivers remain runtime dependencies. Keeping this check outside of the
 * build means `npm pack` fails before an incomplete CLI can be published.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const required = [
  resolve(root, "apps/cli/dist/index.js"),
  resolve(root, "packages/db/migrations/sqlite/meta/_journal.json"),
  resolve(root, "packages/db/migrations/postgres/meta/_journal.json"),
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error("The npm package is incomplete. Missing:");
  for (const file of missing) console.error(`  ${file}`);
  console.error("Run `npm run build -w apps/cli` before packaging.");
  process.exit(1);
}

if (packageJson.private !== false) {
  console.error(
    "The root package must be publishable (`private` must be false).",
  );
  process.exit(1);
}

if (packageJson.bin?.netpro !== "./apps/cli/dist/index.js") {
  console.error("The published package must expose the `netpro` executable.");
  process.exit(1);
}

const source = readFileSync(resolve(root, "apps/cli/dist/index.js"), "utf8");
for (const external of ["better-sqlite3", "pg"]) {
  // Native/CommonJS drivers are intentionally external and are installed from
  // the root package dependencies. This is a release invariant.
  if (!source.includes(external)) {
    console.error(
      `Expected the CLI bundle to retain ${external} as a runtime dependency.`,
    );
    process.exit(1);
  }
}

console.log(
  "NetPro npm package is ready: bundled CLI, SQLite/PostgreSQL migrations, and bin metadata verified.",
);
