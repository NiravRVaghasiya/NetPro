import type { Command } from 'commander';

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import connections from LinkedIn, GitHub, or a manual source')
    .action(() => {
      console.log('netpro import: not yet implemented');
    });
}
