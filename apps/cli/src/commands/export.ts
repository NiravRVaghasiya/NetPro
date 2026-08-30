import type { Command } from 'commander';

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export contacts as CSV, JSON, or vCard')
    .action(() => {
      console.log('netpro export: not yet implemented');
    });
}
