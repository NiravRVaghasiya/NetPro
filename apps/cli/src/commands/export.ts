import type { Command } from "commander";
import { chmodSync, writeFileSync } from "node:fs";
import type { SqliteConn, PgConn } from "@netpro/db";
import { exportContactsCSV } from "@netpro/core/src/export";
import {
  workspacePredicate,
  type WorkspaceScope,
} from "@netpro/core/src/workspaces/scope";

export interface ExportCommandOptions {
  format?: string;
  output?: string;
}

export async function executeExport(
  options: ExportCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<{ output: string; csv: string }> {
  const format = options.format ?? "csv";
  if (format !== "csv") {
    throw new Error(
      `Format "${format}" is not yet supported — only "csv" is available in this phase`,
    );
  }

  const contacts = await listContacts(conn, scope);
  const csv = exportContactsCSV(contacts);

  if (options.output) {
    // Phase 23 — an export is the network in a file: owner-only, like the
    // database and backups. mode covers creation; chmodSync covers overwrite
    // of a pre-existing (possibly looser) file.
    writeFileSync(options.output, csv, { encoding: "utf-8", mode: 0o600 });
    chmodSync(options.output, 0o600);
    return {
      output: `✓ Exported ${contacts.length} contacts to ${options.output}`,
      csv,
    };
  }
  return { output: csv, csv };
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function listContacts(conn: SqliteConn | PgConn, scope?: WorkspaceScope) {
  if (conn.dialect === "sqlite") {
    return conn.db
      .select()
      .from(conn.schema.contacts)
      .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
  }
  return conn.db
    .select()
    .from(conn.schema.contacts)
    .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
}

export function registerExportCommand(program: Command): void {
  const cmd = program
    .command("export")
    .description("Export contacts as CSV, JSON, or vCard")
    .option(
      "--format <format>",
      "csv (only format supported in this phase)",
      "csv",
    )
    .option("--output <path>", "Write to a file instead of stdout")
    .action(async (options: ExportCommandOptions) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const { output } = await executeExport(options, conn, scope);
        console.log(output);
      } catch (e) {
        console.error(`netpro export: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
