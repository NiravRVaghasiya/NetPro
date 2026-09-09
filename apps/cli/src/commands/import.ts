import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { SqliteConn, PgConn } from "@netpro/db";
import { runImport } from "@netpro/core/src/import";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";

export interface ImportCommandOptions {
  linkedin?: string;
}

export async function executeImport(
  options: ImportCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  if (!options.linkedin) {
    throw new Error(
      "--linkedin <path> is required (only LinkedIn CSV import is supported in this phase)",
    );
  }

  const csv = readFileSync(options.linkedin, "utf-8");
  const summary = await runImport(csv, conn, scope);

  const lines = [
    `✓ Imported ${summary.imported} contacts (${summary.merged} merged)`,
  ];
  if (summary.edgeCandidates && summary.edgeCandidates.inserted > 0) {
    lines.push(
      `  ${summary.edgeCandidates.inserted} pending mutual-network edge(s) queued for confirmation (netpro edge list --status pending)`,
    );
  }
  if (summary.errors.length > 0) {
    lines.push(`  ${summary.errors.length} row(s) skipped:`);
    summary.errors.forEach((e) => lines.push(`    row ${e.row}: ${e.reason}`));
  }
  return lines.join("\n");
}

export function registerImportCommand(program: Command): void {
  const cmd = program
    .command("import")
    .description("Import connections from LinkedIn, GitHub, or a manual source")
    .option("--linkedin <path>", "Path to a LinkedIn connections CSV export")
    .action(async (options: ImportCommandOptions) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const output = await executeImport(options, conn, scope);
        console.log(output);
      } catch (e) {
        console.error(`netpro import: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
