import type { Command } from 'commander';

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Analyze your network: score, clusters, dormant ties, paths')
    .action(() => {
      console.log('netpro analyze: not yet implemented');
    });
}
