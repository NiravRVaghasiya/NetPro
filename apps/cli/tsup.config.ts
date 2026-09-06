import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle everything that CAN be bundled, so `dist/index.js` runs from any
  // directory with only the two native modules alongside it. Previously only
  // @netpro/* was bundled, which left `commander` and `drizzle-orm` as bare
  // imports resolved from node_modules at runtime. That works in the repo, but
  // broke in the Docker image, where the CLI is copied next to a Next.js
  // standalone tree that contains neither package:
  //
  //   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'commander'
  //     imported from /app/apps/cli/dist/index.js
  //
  // Enumerating runtime deps in the Dockerfile instead would silently rot
  // every time a dependency is added; bundling makes the artifact correct by
  // construction and is the right shape for a CLI distributed via npm/brew.
  noExternal: [/@netpro\/.*/, 'commander', 'drizzle-orm'],
  // These two cannot be bundled and must be resolvable at runtime:
  // better-sqlite3 is a native addon, and pg is CommonJS that loads optional
  // native/pure-JS backends dynamically.
  external: ['better-sqlite3', 'pg'],
  banner: {
    // commander is CommonJS. When esbuild inlines it into an ESM bundle its
    // internal `require('events')` hits esbuild's stub, which throws
    // "Dynamic require of \"events\" is not supported" at startup. Providing a
    // real createRequire-backed `require` for the bundle scope fixes those
    // built-in lookups. Node's own ESM `import` is unaffected.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __netproCreateRequire } from 'node:module';",
      'const require = __netproCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
