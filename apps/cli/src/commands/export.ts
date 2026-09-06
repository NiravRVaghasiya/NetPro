import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import type { SqliteConn, PgConn } from '@netpro/db';
import { exportContactsCSV } from '@netpro/core/src/export';

export interface ExportCommandOptions {
  format?: string;
  output?: string;
}

export async function executeExport(
  options: ExportCommandOptions,
  conn: SqliteConn | PgConn
): Promise<{ output: string; csv: string }> {
  const format = options.format ?? 'csv';
  if (format !== 'csv') {
    throw new Error(`Format "${format}" is not yet supported — only "csv" is available in this phase`);
  }

  const contacts = await listContacts(conn);
  const csv = exportContactsCSV(contacts);

  if (options.output) {
    writeFileSync(options.output, csv, 'utf-8');
    return { output: `✓ Exported ${contacts.length} contacts to ${options.output}`, csv };
  }
  return { output: csv, csv };
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function listContacts(conn: SqliteConn | PgConn) {
  if (conn.dialect === 'sqlite') {
    return conn.db.select().from(conn.schema.contacts);
  }
  return conn.db.select().from(conn.schema.contacts);
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export contacts as CSV, JSON, or vCard')
    .option('--format <format>', 'csv (only format supported in this phase)', 'csv')
    .option('--output <path>', 'Write to a file instead of stdout')
    .action(async (options: ExportCommandOptions) => {
      const { openDb } = await import('../db');
      try {
        const { output } = await executeExport(options, await openDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro export: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
