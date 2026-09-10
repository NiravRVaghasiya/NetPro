// packages/server/src/bin.ts
//
// Standalone executable entry for @netpro/server (`netpro-server`).
// Kept separate from src/index.ts so that bundling the library into the CLI
// (tsup inlines @netpro/*) can never auto-start a server as an import side
// effect — the Phase 1 argv-sniffing heuristic could not distinguish the
// CLI's own dist/index.js from this package's.
//
// Users should normally run `netpro serve`; this bin exists for
// package-level scripts and container images built from the server package.

import { main } from './serve';

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
