import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle workspace packages the same way the CLI does so the artifact is
  // self-contained for a future `netpro serve` / Docker path. Native drivers
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
