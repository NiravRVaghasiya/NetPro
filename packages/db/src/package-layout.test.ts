// The *published* layout is a release invariant, and the first release is
// exactly what proved it worth pinning: `npm install -g netpro-<version>.tgz`
// unpacks the bundle to <pkg>/apps/cli/dist/index.js and the migrations (from
// package.json "files") to <pkg>/packages/db/migrations — but no candidate in
// the resolver looked at <pkg>/packages/db, so the installed CLI failed with
//
//     Could not locate @netpro/db migrations for "sqlite"
//
// while every in-repo test passed, because a checkout resolves `@netpro/db`
// through node_modules and runs with the repo's own packages/db on disk. The
// in-repo smokes cannot see this class of bug; installed-package.sh runs the
// real tarball for that, and this test holds the resolution itself still.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrationCandidates } from "./migrate";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "netpro-layout-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

/** The first candidate that actually holds this dialect's journal. */
function resolvedFrom(candidates: string[], dialect: string): string | undefined {
  return candidates.find((dir) =>
    existsSync(join(dir, "migrations", dialect, "meta", "_journal.json")),
  );
}

describe("migrations resolve from every layout NetPro ships", () => {
  it("finds them in the published tarball layout, from the bundled CLI's own path", () => {
    const root = scratchDir();
    // What `npm install -g netpro-<version>.tgz` produces, from package.json
    // "files": the bundled CLI plus both migration sets.
    mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
    for (const dialect of ["sqlite", "postgres"]) {
      mkdirSync(join(root, "packages", "db", "migrations", dialect, "meta"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "packages", "db", "migrations", dialect, "meta", "_journal.json"),
        JSON.stringify({ dialect, entries: [] }),
      );
    }

    // cwd is deliberately somewhere unrelated: on a user's machine nothing
    // outside the package knows where it was unpacked.
    const candidates = migrationCandidates(
      join(root, "apps", "cli", "dist"),
      join(root, "elsewhere"),
    );

    for (const dialect of ["sqlite", "postgres"]) {
      expect(resolvedFrom(candidates, dialect)).toBe(join(root, "packages", "db"));
    }
  });

  it("finds them in the workspace layout used by the repo and the Docker image", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const candidates = migrationCandidates(
      join(repoRoot, "packages", "db", "src"),
      join(repoRoot, "apps", "web"),
    );

    for (const dialect of ["sqlite", "postgres"]) {
      expect(resolvedFrom(candidates, dialect)).toBe(join(repoRoot, "packages", "db"));
    }
  });

  it("does not require import.meta.url to be a file URL", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // A bundler that rewrites import.meta.url leaves the cwd candidates.
    const candidates = migrationCandidates(undefined, repoRoot);
    expect(candidates.length).toBeGreaterThan(0);

    const candidatesInRepo = migrationCandidates(undefined, join(repoRoot, "apps", "web"));
    expect(resolvedFrom(candidatesInRepo, "sqlite")).toBe(
      join(repoRoot, "packages", "db"),
    );
  });
});
