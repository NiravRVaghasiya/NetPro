import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `netpro serve` tests boot a real HTTP server, apply all 15 migrations,
    // and (since Phase 24) start the retention purge — far more than the
    // default 5s when the monorepo builds/tests run in parallel.
    testTimeout: 20_000,
  },
});
