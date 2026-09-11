#!/usr/bin/env node

/**
 * Move the release version everywhere it is written down:
 *
 *   npm run release:bump -- 3.0.1
 *
 * The version lives in three kinds of file, and only the first kind is obvious:
 *
 *   1. the seven `package.json` files (root + `apps/*` + `packages/*`) — the
 *      number the tarball, the lockfile and `npm ci` all agree on;
 *   2. `apps/cli/src/cli.ts`, where commander's `.version()` is a literal baked
 *      into the bundle. The published CLI has no `package.json` sitting next to
 *      it to read from, so a release that bumps only the manifests ships a CLI
 *      that still reports the *previous* version — and the release gate's
 *      installed-package smoke, which compares `netpro --version` against the
 *      tarball's own version, fails an hour later instead of here;
 *   3. `packages/server/src/version.ts`, rendered into the built-in console page
 *      and returned by `GET /api/settings`.
 *
 * Both literals are pinned against the root `package.json` by unit tests
 * (`apps/cli/src/cli.test.ts`, `packages/server/src/version.test.ts`), so a
 * hand-edit that forgets one fails in CI even if this script is not used.
 *
 * What this script does not touch: the install URLs and version mentions in
 * `README.md`, `docs/getting-started.md` and the new `docs/releases/<tag>.md`.
 * Those are prose (the historical release notes must keep their own numbers),
 * so they stay a reviewed edit — see the checklist in `docs/releasing.md`.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version) {
  console.error("Usage: npm run release:bump -- <version>   (e.g. 3.0.1)");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${version}" is not a version the release workflow would accept.`);
  process.exit(1);
}

const relative = (file) => file.slice(root.length + 1).replaceAll("\\", "/");

const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((group) =>
    readdirSync(resolve(root, group)).map((name) => `${group}/${name}/package.json`),
  ),
].map((file) => resolve(root, file));

// Regexes, not a JSON round-trip, so the diff stays a one-line change per file:
// re-serializing a manifest rewrites escapes (`\u2014` → `—`) and turns a
// version bump into a review of unrelated lines. Each pattern must match, or the
// script fails loudly rather than shipping a release that is only half-bumped.
const manifestVersion = /^  "version": "[^"]*",$/m;

const literals = [
  {
    file: resolve(root, "apps/cli/src/cli.ts"),
    pattern: /\.version\("[^"]*"\)/,
    replacement: () => `.version("${version}")`,
    what: "the CLI's reported version",
  },
  {
    file: resolve(root, "packages/server/src/version.ts"),
    pattern: /SERVER_VERSION = "[^"]*"/,
    replacement: () => `SERVER_VERSION = "${version}"`,
    what: "the server's reported version",
  },
];

let changed = 0;

for (const file of manifests) {
  const before = readFileSync(file, "utf8");
  const match = before.match(manifestVersion);
  if (!match) {
    console.error(`\nCould not find a top-level version in ${relative(file)}.`);
    process.exit(1);
  }
  const after = before.replace(manifestVersion, `  "version": "${version}",`);
  if (after === before) continue;
  writeFileSync(file, after);
  console.log(`  ${relative(file)}: ${match[0].trim()} → "version": "${version}",`);
  changed += 1;
}

for (const { file, pattern, replacement, what } of literals) {
  const before = readFileSync(file, "utf8");
  if (!pattern.test(before)) {
    console.error(
      `\nCould not find ${what} in ${relative(file)}. The literal moved — update this script.`,
    );
    process.exit(1);
  }
  const after = before.replace(pattern, replacement());
  if (after === before) continue;
  writeFileSync(file, after);
  console.log(`  ${relative(file)}: ${before.match(pattern)[0]} → ${after.match(pattern)[0]}`);
  changed += 1;
}

if (changed === 0) {
  console.log(`Nothing to do — everything already says ${version}.`);
  process.exit(0);
}

console.log(`\n${changed} file(s) now say ${version}. Still to do:`);
console.log("  1. npm install --package-lock-only   # relock the workspace versions");
console.log("  2. update the install URLs in README.md and docs/getting-started.md,");
console.log(`     then write docs/releases/v${version}.md (it becomes the release body)`);
console.log("  3. npm run lint && npm test && scripts/smoke/installed-package.sh");
