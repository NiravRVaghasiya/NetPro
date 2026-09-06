import type { Command } from 'commander';
import { Keychain } from '../config/keychain';

export interface ConfigCommandArgs {
  action: 'set' | 'get' | 'delete' | 'list';
  key?: string;
  value?: string;
}

export async function executeConfig(args: ConfigCommandArgs): Promise<string> {
  switch (args.action) {
    case 'set': {
      if (!args.key || args.value === undefined) {
        throw new Error('Usage: netpro config set <key> <value>');
      }
      await Keychain.set(args.key, args.value);
      return `✓ Set ${args.key}`;
    }
    case 'get': {
      if (!args.key) throw new Error('Usage: netpro config get <key>');
      const value = await Keychain.get(args.key);
      return value === null ? `${args.key}: not set` : value;
    }
    case 'delete': {
      if (!args.key) throw new Error('Usage: netpro config delete <key>');
      await Keychain.delete(args.key);
      return `✓ Deleted ${args.key}`;
    }
    case 'list': {
      const keys = await Keychain.listKeys();
      return keys.length === 0 ? 'No configuration keys set.' : keys.map((k) => `  ${k}`).join('\n');
    }
    default:
      throw new Error(`Unknown config action "${(args as { action: string }).action}"`);
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage NetPro configuration (API keys are stored encrypted in ~/.netpro)');

  config
    .command('set')
    .argument('<key>', 'Configuration key, e.g. enrichment.hunter')
    .argument('<value>', 'Value to store')
    .description('Set a configuration value')
    .action(async (key: string, value: string) => {
      try {
        console.log(await executeConfig({ action: 'set', key, value }));
      } catch (e) {
        console.error(`netpro config: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  config
    .command('get')
    .argument('<key>', 'Configuration key')
    .description('Print a configuration value')
    .action(async (key: string) => {
      try {
        console.log(await executeConfig({ action: 'get', key }));
      } catch (e) {
        console.error(`netpro config: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  config
    .command('delete')
    .argument('<key>', 'Configuration key')
    .description('Delete a configuration value')
    .action(async (key: string) => {
      try {
        console.log(await executeConfig({ action: 'delete', key }));
      } catch (e) {
        console.error(`netpro config: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  config
    .command('list')
    .description('List all configured keys')
    .action(async () => {
      try {
        console.log(await executeConfig({ action: 'list' }));
      } catch (e) {
        console.error(`netpro config: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
