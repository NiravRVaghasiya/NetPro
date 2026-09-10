import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { SqliteConn, PgConn } from "@netpro/db";
import { runImport, previewImport } from "@netpro/core/src/import";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";

export interface ImportCommandOptions {
  /** Positional `netpro import linkedin.csv` (Phase 15). */
  file?: string;
  /** Legacy `--linkedin <path>` — kept for backwards compatibility. */
  linkedin?: string;
  /** Phase 15 — preview/validate without importing. */
  preview?: boolean;
}

function resolveCsvPath(options: ImportCommandOptions): string {
  const path = options.linkedin ?? options.file;
  if (!path) {
    throw new Error(
      "A CSV file is required: `netpro import linkedin.csv` (or `--linkedin <path>`).",
    );
  }
  return path;
}

export async function executeImport(
  options: ImportCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const path = resolveCsvPath(options);
  const csv = readFileSync(path, "utf-8");
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

/**
 * Phase 15 — the same preview/validate step the Web UI's import flow uses,
 * driven from the terminal. `previewImport` is the one shared implementation,
 * so a row flagged here is exactly a row `netpro import` will skip.
 */
export async function executeImportPreview(
  options: ImportCommandOptions,
): Promise<string> {
  const path = resolveCsvPath(options);
  const csv = readFileSync(path, "utf-8");
  const preview = previewImport(csv, { limit: 10, maxIssues: 20 });

  const lines = [
    `Preview of ${path} (source: ${preview.source})`,
    `Columns: ${preview.columns.join(", ")}`,
    `Rows: ${preview.totalRows} total — ${preview.validRows} valid, ${preview.invalidRows} will be skipped`,
  ];
  for (const contact of preview.contacts.slice(0, 10)) {
    const name = contact.valid ? contact.fullName : `row ${contact.row} (${contact.issue})`;
    lines.push(
      `  ${contact.valid ? "✓" : "✗"} ${name}${contact.company ? ` — ${contact.company}` : ""}`,
    );
  }
  if (preview.issues.length > 0) {
    lines.push(`Validation issues:`);
    for (const issue of preview.issues.slice(0, 20)) {
      lines.push(`  row ${issue.row}: ${issue.reason}`);
    }
    if (preview.issuesTruncated) lines.push(`  … and more`);
  }
  return lines.join("\n");
}

export function registerImportCommand(program: Command): void {
  const cmd = program
    .command("import")
    .description("Import connections from LinkedIn, GitHub, or a manual source")
    // Phase 15 — `netpro import linkedin.csv` is the canonical invocation.
    .argument("[file]", "Path to a LinkedIn connections CSV export")
    .option("--linkedin <path>", "Path to a LinkedIn connections CSV export")
    .option("--preview", "Preview and validate the CSV without importing")
    .action(async (file: string | undefined, options: ImportCommandOptions) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const resolved = { ...options, file: file ?? options.file };
        if (resolved.preview) {
          console.log(await executeImportPreview(resolved));
          return;
        }
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const output = await executeImport(resolved, conn, scope);
        console.log(output);
      } catch (e) {
        console.error(`netpro import: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
