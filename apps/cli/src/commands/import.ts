import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { SqliteConn, PgConn } from '@netpro/db';
import { runImport } from '@netpro/core/src/import';

export interface ImportCommandOptions {
  linkedin?: string;
}

export async function executeImport(options: ImportCommandOptions, conn: SqliteConn | PgConn): Promise<string> {
  if (!options.linkedin) {
    throw new Error('--linkedin <path> is required (only LinkedIn CSV import is supported in this phase)');
  }

  const csv = readFileSync(options.linkedin, 'utf-8');
  const summary = await runImport(csv, conn);

  const lines = [`✓ Imported ${summary.imported} contacts (${summary.merged} merged)`];
  if (summary.errors.length > 0) {
    lines.push(`  ${summary.errors.length} row(s) skipped:`);
    summary.errors.forEach((e) => lines.push(`    row ${e.row}: ${e.reason}`));
  }
  return lines.join('\n');
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import connections from LinkedIn, GitHub, or a manual source')
    .option('--linkedin <path>', 'Path to a LinkedIn connections CSV export')
    .action(async (options: ImportCommandOptions) => {
      const { createDb } = await import('@netpro/db');
      try {
        const output = await executeImport(options, createDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro import: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
