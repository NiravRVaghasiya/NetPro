import { defineConfig } from 'tsup';

export default defineConfig({
  // index.ts is the library surface (imported by apps/cli); bin.ts is the
  // standalone `netpro-server` executable. Keeping them separate means
  // importing the library never starts a server as an import side effect.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle workspace packages the same way the CLI does so the artifact is
  // self-contained for the `netpro serve` / Docker path. Native drivers
  // stay external.
  noExternal: [/@netpro\/.*/, 'drizzle-orm'],
  external: ['better-sqlite3', 'pg'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __netproCreateRequire } from 'node:module';",
      'const require = __netproCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
