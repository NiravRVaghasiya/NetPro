// Next.js instrumentation hook — runs once per server process at startup,
// before any request is handled. This is where pending Drizzle migrations
// are applied, because the Postgres migrator is async and can't run from
// module-scope `lib/db.ts` (a deliberate scaffold design kept as-is).
//
// PHASE 6 — the migration logic itself moved to @netpro/db's runMigrations(),
// shared with the CLI and the `netpro-migrate` deploy command. That runner
// takes a Postgres advisory lock, which is what makes a Vercel deploy safe:
// many instances cold-start at once and would otherwise race to run the same
// DDL (measured: 5 of 6 concurrent migrators failed). See
// packages/db/src/migrate.ts.
//
// On Vercel the recommended setup is to run migrations once at build time
// (`npm run db:migrate`) and set NETPRO_AUTO_MIGRATE=false, so request paths
// never attempt DDL at all. This hook stays the default for Docker and local
// development, where there is no separate deploy step.
//
// v2.5 Phase 6 also schedules the daily retention purge here (see
// `lib/retention.ts`): in-memory, self-guarded to one run per 24 h, and
// independent of the migration policy above.

// This file has a `.node.ts` sibling-free design on purpose: Next.js evaluates
// instrumentation in BOTH the nodejs and edge runtimes, so every node-only
// import stays behind the runtime guard and a dynamic import boundary. Static
// imports of node:fs/node:path/@netpro/db here would crash the edge context —
// the same class of bug as the scaffold's middleware/better-sqlite3 incident
// (v0.1-alpha progress log, Task 11).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { runMigrations, autoMigrateEnabled } = await import('@netpro/db');
  const { conn } = await import('@/lib/db');

  if (!autoMigrateEnabled()) {
    console.info(
      '[netpro] NETPRO_AUTO_MIGRATE is disabled — skipping startup migrations. ' +
        'Run `npm run db:migrate` as a deploy step.'
    );
  } else {
    await runMigrations(conn);
  }

  // v2.5 Phase 6 — the daily retention purge. Independent of the migration
  // policy: it is DML, not DDL, and a deploy that migrates as a build step
  // still wants its raw views (90 d) and content snapshots (365 d) bounded.
  // The core guard makes at most one run per 24 h, so cold-start storms on
  // serverless collapse into a single daily purge; the 24 h interval keeps
  // a long-lived container on cadence. Fire-and-forget by design.
  const { scheduleRetentionPurge } = await import('@/lib/retention');
  scheduleRetentionPurge(conn);
}
