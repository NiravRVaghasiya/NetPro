# Releasing NetPro

A release is an **annotated tag** (`v3.0.0`) at a commit on `master`. Pushing it
runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which
re-proves the build and publishes the GitHub Release with the installable CLI
bundle attached. Nothing is ever published from a working branch, and the
workflow refuses a tag whose commit is not on the default branch.

| Artifact | Produced by | How it is used |
| --- | --- | --- |
| `netpro-<version>.tgz` | `npm pack` at the tagged commit | `npm install -g <release-asset-url>` |
| `SHA256SUMS` | `sha256sum` over the tarball | `shasum -a 256 -c SHA256SUMS` |
| Source code (`.tar.gz` / `.zip`) | GitHub, for the tag | Read the code at the release |

> **The npm registry.** The unscoped name `netpro` on npm is held by an
> unrelated package, so NetPro is not published there and `npm install -g netpro`
> does **not** install this project. The release tarball is the supported
> global-install path; `npm install -g <tarball>` installs the real CLI with its
> bundled server, migrations and native drivers. If publishing is wanted later,
> either claim the name with a scope (`@your-scope/netpro` — the root
> `package.json` is already `private: false` with `publishConfig.access: public`,
> and `npm run package:check` gates the contents) or keep shipping the asset.

## Cutting a release

1. **Bump the version.** The root `package.json` holds the released version;
   every workspace `package.json` carries the same number (they are `private`
   and never published individually). Keep them identical — the workflow fails
   the release if the tag and `package.json` disagree.

   ```bash
   # 3.0.0 → 3.1.0 in the root and in apps/* and packages/*
   node -e "
     const fs = require('node:fs');
     const files = ['package.json', ...fs.readdirSync('apps').map((d) => \`apps/\${d}/package.json\`), ...fs.readdirSync('packages').map((d) => \`packages/\${d}/package.json\`)];
     for (const file of files) {
       const json = JSON.parse(fs.readFileSync(file, 'utf8'));
       json.version = '3.1.0';
       fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
     }
   "
   git diff --stat   # root + apps/cli + apps/web + packages/{config,core,db,server}
   ```

2. **Write the release notes** at `docs/releases/v3.1.0.md`. Its H1 becomes the
   release title and the file becomes the release body verbatim, so the notes
   are reviewed in the pull request like any other change. `v3.0.0` is the
   reference: what the release is, install, highlights, what was verified,
   what is deliberately deferred.

3. **Update the documentation that states a version or an install command.**
   `README.md` (the version badge, quickstart install URL, the test counts in
   *Development*), `docs/getting-started.md` (install/smoke commands), and the
   release-asset URL in the new notes file.

4. **Merge to `master`** and wait for the CI gate to go green — that is where
   the PostgreSQL integration suites, the server smoke on both dialects, the
   Web UI smoke and the Docker image e2e run.

5. **Tag and push the tag.**

   ```bash
   git tag -a v3.1.0 -m 'NetPro v3.1.0 — <one-line summary>'
   git push origin v3.1.0
   ```

6. **Watch the release run** and check what was published.

   ```bash
   gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')"
   gh release view v3.1.0
   ```

7. **Install it the way a user would** — the only check that proves the release
   rather than the build:

   ```bash
   npm install -g https://github.com/NiravRVaghasiya/NetPro/releases/download/v3.1.0/netpro-3.1.0.tgz
   netpro --version   # 3.1.0
   netpro init        # with NETPRO_HOME pointed at a scratch directory
   ```

## What the release workflow verifies

The gate job runs `npm ci` → `lint` → `typecheck` → `test` → `build` →
`scripts/smoke/cli.sh` → `npm pack`, then verifies the artifact two ways:

1. **Statically** — the tarball it just built is extracted and asserted:
   name/version/publishable, `bin.netpro` points at the bundled CLI, the CLI
   bundle is present, both migration sets are present, and `better-sqlite3` +
   `pg` remain runtime dependencies.
2. **As installed** — `scripts/smoke/installed-package.sh` installs *that*
   tarball into a scratch global prefix and runs the shipped CLI from a neutral
   working directory: `--version`, `init`, `migrate --status`, `status`. This is
   the check that matters, because it is the only one that sees the published
   layout: `packages/db/migrations` next to a bundled `apps/cli/dist/index.js`,
   with no `@netpro/db` in `node_modules` and no repo `packages/db` in cwd. The
   first v3.0.0 tarball contained every migration file and still could not run
   `netpro init` once installed; this step fails instead. The same script runs on
   every push to `master` in the `build` job of `ci.yml`.

Only then does the release job create the release and upload
`netpro-<version>.tgz` and `SHA256SUMS`.

The deep gates are deliberately *not* duplicated here — they run on every push
to `master` in [`ci.yml`](../.github/workflows/ci.yml), and the gate job refuses
a tag that is not on the default branch. A release therefore sits on a commit
that already passed: PostgreSQL integration (including the performance pass and
migration idempotency), the marketplace end-to-end install, the server smoke on
SQLite *and* PostgreSQL, the standalone Web UI smoke, and the Docker image e2e.

## Re-running a release

The job is idempotent: it edits the notes if the release already exists and
uploads assets with `--clobber`. Re-run it from the Actions tab with
**Run workflow → Release**, passing the existing tag — use this when a release
run failed after the tag was pushed, or when only the notes changed.

To fix the release *contents* (a broken artifact), push the fix to `master` and
cut the release again. Prefer a **new patch version** once anyone may have
downloaded the bad artifact — a published tag is a promise. Re-pointing a tag is
only appropriate while it has not been consumed: the v3.0.0 cut was re-created
minutes after it first published, with zero downloads, because the first tarball
could not run once installed.

```bash
gh release delete v3.1.0 --yes        # remove the release first
git push origin :refs/tags/v3.1.0     # delete the bad tag
git push origin v3.1.0                # re-create at the new commit
```

`gh release view v3.1.0 --json assets -q '.assets[].downloadCount'` is the check
for "has anyone consumed it".

## Doing it by hand (fallback)

If the workflow is unavailable, the same artifacts can be produced locally:

```bash
npm ci
npm run build
npm run package:check
mkdir -p dist-assets && npm pack --pack-destination dist-assets
scripts/smoke/installed-package.sh dist-assets/netpro-3.1.0.tgz   # run it, don't just pack it
(cd dist-assets && sha256sum ./*.tgz > SHA256SUMS)

gh release create v3.1.0 --verify-tag \
  --title "NetPro v3.1.0 — <summary>" \
  --notes-file docs/releases/v3.1.0.md \
  dist-assets/*
```
