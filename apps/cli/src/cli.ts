import { Command } from 'commander';
import { registerInitCommand } from './commands/init';
import { registerImportCommand } from './commands/import';
import { registerEnrichCommand } from './commands/enrich';
import { registerSearchCommand } from './commands/search';
import { registerOutreachCommand } from './commands/outreach';
import { registerAnalyzeCommand } from './commands/analyze';
import { registerTrackCommand } from './commands/track';
import { registerExportCommand } from './commands/export';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('netpro')
    .description('NetPro — your professional network, owned by you')
    .version('0.1.0-alpha.0');

  registerInitCommand(program);
  registerImportCommand(program);
  registerEnrichCommand(program);
  registerSearchCommand(program);
  registerOutreachCommand(program);
  registerAnalyzeCommand(program);
  registerTrackCommand(program);
  registerExportCommand(program);

  return program;
}
