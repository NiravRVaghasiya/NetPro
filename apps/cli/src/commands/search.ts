import type { Command } from 'commander';

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search your contacts and federated sources')
    .action(() => {
      console.log('netpro search: not yet implemented');
    });
}
