import type { Command } from 'commander';

export function registerOutreachCommand(program: Command): void {
  program
    .command('outreach')
    .description('Compose and send AI-assisted outreach')
    .action(() => {
      console.log('netpro outreach: not yet implemented');
    });
}
