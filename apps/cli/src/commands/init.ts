import type { Command } from 'commander';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Interactive setup wizard')
    .action(() => {
      console.log('netpro init: not yet implemented');
    });
}
