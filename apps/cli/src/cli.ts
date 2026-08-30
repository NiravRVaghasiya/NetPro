import { Command } from 'commander';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('netpro')
    .description('NetPro — your professional network, owned by you')
    .version('0.1.0-alpha.0');

  return program;
}
