import type { Command } from 'commander';

export function registerTrackCommand(program: Command): void {
  program
    .command('track')
    .description('Track CRM interactions and follow-ups')
    .action(() => {
      console.log('netpro track: not yet implemented');
    });
}
