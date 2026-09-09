import type { SqliteConn, PgConn } from "@netpro/db";
import type { Command } from "commander";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";

/**
 * createDb() plus auto-apply of pending migrations. Per the "DB & Pipeline
 * Deep Dive" blueprint's migration strategy, the CLI auto-runs pending
 * migrations on startup. Application is journal-based and idempotent (a
 * no-op once applied), and deliberately unconfirmed: the CLI is designed to
 * be cron/script-friendly, and no migration in this phase is breaking.
 *
 * The migration runner itself lives in @netpro/db so the CLI, the web server,
 * and the standalone `netpro-migrate` deploy command share one implementation
 * — including the Postgres advisory lock that makes concurrent migrators safe
 * (see packages/db/src/migrate.ts for the measured race this prevents).
 *
 * `@netpro/db` is imported dynamically (not statically) so that commands that
 * don't touch the database — `--help`, `config` — never load the
 * better-sqlite3/pg native modules. Same pattern as the scaffold's command
 * actions.
 */
export async function openDb(): Promise<SqliteConn | PgConn> {
  const { createDb, runMigrations, autoMigrateEnabled } =
    await import("@netpro/db");
  const conn = createDb();

  // NETPRO_AUTO_MIGRATE=false lets an operator who runs migrations as an
  // explicit deploy step keep the CLI read-only against that database.
  if (autoMigrateEnabled()) await runMigrations(conn);
  return conn;
}

// ── Workspace scope (v3.0 Phase 2) ───────────────────────────────────────
//
// Every core function a command calls takes an optional `WorkspaceScope`.
// The CLI resolves it once per invocation from, in precedence order:
//
//   1. the global `--workspace <id>` flag,
//   2. the `NETPRO_WORKSPACE` environment variable,
//   3. the persisted config value `workspace` (per-install default),
//
// falling back to the bootstrap workspace — which, being `undefined`, keeps
// every existing single-owner install byte-identical. A CLI is the machine
// owner: the resolved scope is owner-role with the synthetic `system`
// actor, and command-level audit rows keep distinguishing real web users.

/**
 * Resolve the invocation's workspace scope, or `undefined` for the bootstrap
 * path. An explicit id is validated for shape and for existence in the
 * `workspaces` table — a typo fails loudly instead of silently filtering to
 * an empty workspace.
 */
export async function resolveCliScope(
  cmd: Command,
  conn?: SqliteConn | PgConn,
): Promise<WorkspaceScope | undefined> {
  const { BOOTSTRAP_WORKSPACE_ID, SYSTEM_USER_ID } =
    await import("@netpro/core/src/workspaces/scope");

  const globalOpts = cmd.optsWithGlobals() as { workspace?: string };
  let id =
    typeof globalOpts.workspace === "string" &&
    globalOpts.workspace.trim() !== ""
      ? globalOpts.workspace.trim()
      : (process.env.NETPRO_WORKSPACE?.trim() ?? "");
  if (!id) {
    try {
      const { getConfigValue } = await import("./config/config");
      id = (await getConfigValue("workspace"))?.trim() ?? "";
    } catch {
      id = "";
    }
  }
  if (!id || id === BOOTSTRAP_WORKSPACE_ID) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `Invalid workspace id "${id}" (letters, digits, "-" and "_" only).`,
    );
  }
  if (conn) {
    const { sql } = await import("drizzle-orm");
    const { rawAll } = await import("@netpro/core/src/search/indexer");
    const rows = await rawAll<{ id: string }>(
      conn,
      sql`SELECT id FROM workspaces WHERE id = ${id} LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new Error(
        `Unknown workspace "${id}". Create it first (web UI → switch workspace) or run without --workspace for the default.`,
      );
    }
  }
  return { workspaceId: id, role: "owner", userId: SYSTEM_USER_ID };
}
