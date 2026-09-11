import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { SqliteConn, PgConn } from "@netpro/db";
import { runImport, previewImport } from "@netpro/core/src/import";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import { runCliJob, type CliJobEmitter } from "../lib/jobs";

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

/**
 * Import, optionally observed.
 *
 * Phase 16 — when `emit` is supplied (the command wires it to a Job) the
 * import publishes the same `import.*` events the server's `POST /api/import`
 * does, and they reach the same SSE stream, so an import started in a terminal
 * shows up in the Web UI's Activity feed live. Without `emit` the behaviour is
 * byte-identical to before — tests and scripted callers are unaffected.
 */
export async function executeImport(
  options: ImportCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
  emit?: CliJobEmitter,
): Promise<string> {
  const path = resolveCsvPath(options);
  const csv = readFileSync(path, "utf-8");

  emit?.publish({ type: "import.started", progress: 5, message: `Importing ${path}`, file: path });
  emit?.update(5, `Importing ${path}`);

  emit?.publish({ type: "import.progress", progress: 50, message: "Parsing and inserting contacts" });
  emit?.update(50, "Parsing and inserting contacts");
  const summary = await runImport(csv, conn, scope);
  emit?.publish({
    type: "import.completed",
    progress: 100,
    message: `Imported ${summary.imported} contacts`,
    imported: summary.imported,
    merged: summary.merged,
    skipped: summary.errors.length,
    file: path,
  });
  emit?.update(100, `Imported ${summary.imported} contacts`);

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
        // Phase 16 — the import runs as the same Job the Web UI's import does
        // and publishes into the same event stream, so a terminal import is
        // visible in Activity/Import while it runs.
        const execution = await runCliJob({
          type: "import",
          metadata: { file: resolved.file ?? resolved.linkedin ?? null, origin: "cli" },
          run: (emit) => executeImport(resolved, conn, scope, emit),
        });
        console.log(execution.result);
      } catch (e) {
        console.error(`netpro import: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
