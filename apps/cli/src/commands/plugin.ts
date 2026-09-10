// apps/cli/src/commands/plugin.ts
// v3.0 Phase 5 — plugin lifecycle CLI.

import { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  listPlugins,
  getPluginByName,
  createPlugin,
  deletePlugin,
  updatePluginSettings,
} from '@netpro/core/src/plugins/repository';
import {
  enablePlugin,
  disablePlugin,
  getPluginDirs,
  discoverPluginsFromDir,
} from '@netpro/core/src/plugins/runtime';
import { validateManifest } from '@netpro/core/src/plugins/manifest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Conn = SqliteConn | PgConn;

function formatPluginLine(p: { name: string; version: string; enabled: boolean; installedFrom: string | null }) {
  const status = p.enabled ? 'enabled' : 'disabled';
  const src = p.installedFrom ? ` from ${p.installedFrom}` : '';
  return `${p.name}@${p.version} [${status}]${src}`;
}

export function registerPluginCommand(program: Command) {
  const plugin = program.command('plugin').description('Manage NetPro plugins (v3.0 Phase 5)');

  plugin
    .command('list')
    .description('List installed plugins')
    .option('--json', 'JSON output')
    .action(async function (this: Command, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      const items = await listPlugins(conn, scope);
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('No plugins installed. Place plugins in ./plugins or set NETPRO_PLUGIN_DIR.');
        return;
      }
      for (const p of items) {
        console.log(formatPluginLine(p));
      }
    });

  plugin
    .command('paths')
    .description('Show plugin load paths')
    .action(() => {
      const dirs = getPluginDirs();
      console.log('Plugin directories:');
      for (const d of dirs) console.log(`  ${d}`);
    });

  plugin
    .command('discover')
    .description('Discover plugins on disk (not yet installed)')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const dirs = getPluginDirs();
      const all: Array<{ name: string; version: string; path: string; error?: string }> = [];
      for (const dir of dirs) {
        const discovered = await discoverPluginsFromDir(dir);
        for (const d of discovered) {
          all.push({ name: d.manifest.name, version: d.manifest.version, path: d.path, error: d.error });
        }
      }
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        console.log('No plugins discovered on disk.');
        return;
      }
      for (const p of all) {
        const err = p.error ? ` — error: ${p.error}` : '';
        console.log(`${p.name}@${p.version} at ${p.path}${err}`);
      }
    });

  plugin
    .command('info')
    .description('Show plugin details')
    .argument('<name>', 'Plugin name')
    .option('--json', 'JSON output')
    .action(async function (this: Command, name: string, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      const item = await getPluginByName(conn, name, scope);
      if (!item) {
        console.error(`Plugin ${name} not found.`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(item, null, 2));
        return;
      }
      console.log(`Name: ${item.name}`);
      console.log(`Version: ${item.version}`);
      console.log(`Enabled: ${item.enabled}`);
      console.log(`Installed from: ${item.installedFrom ?? 'unknown'}`);
      console.log(`Installed by: ${item.installedByUser ?? 'unknown'}`);
      console.log(`Manifest: ${JSON.stringify(item.manifest, null, 2)}`);
      console.log(`Settings: ${JSON.stringify(item.settings ?? {}, null, 2)}`);
    });

  plugin
    .command('install')
    .description('Install a plugin from a manifest.json file (Phase 5 local install; marketplace in Phase 6)')
    .argument('<manifestPath>', 'Path to manifest.json')
    .option('--from <path>', 'Installed from path')
    .option('--json', 'JSON output')
    .action(async function (this: Command, manifestPath: string, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      const fullPath = resolve(manifestPath);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(fullPath, 'utf8'));
      } catch (e) {
        console.error(`Failed to read manifest: ${(e as Error).message}`);
        process.exit(1);
      }
      let manifest;
      try {
        manifest = validateManifest(raw);
      } catch (e) {
        console.error(`Invalid manifest: ${(e as Error).message}`);
        process.exit(1);
      }
      try {
        const created = await createPlugin(
          conn,
          {
            name: manifest.name,
            version: manifest.version,
            manifest,
            installedFrom: opts.from ?? fullPath,
            installedByUser: scope?.userId ?? 'system',
          },
          scope
        );
        if (opts.json) console.log(JSON.stringify(created, null, 2));
        else
          console.log(
            `Installed ${created.name}@${created.version} (disabled by default). Review permissions then run: netpro plugin enable ${created.name} --i-have-reviewed-permissions`
          );
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  plugin
    .command('enable')
    .description('Enable a plugin (requires permission review)')
    .argument('<name>', 'Plugin name')
    .option('--i-have-reviewed-permissions', 'Confirm you have reviewed permissions')
    .action(async function (this: Command, name: string, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      if (!opts.iHaveReviewedPermissions) {
        console.error('You must review the plugin permissions first. Pass --i-have-reviewed-permissions after reviewing manifest.');
        const item = await getPluginByName(conn, name, scope);
        if (item) {
          console.error(`Permissions for ${name}:`);
          console.error(`  capabilities: ${item.manifest.permissions.capabilities.join(', ')}`);
          console.error(`  network: ${(item.manifest.permissions.network ?? []).join(', ') || '(none)'}`);
        }
        process.exit(1);
      }
      try {
        const updated = await enablePlugin(conn, name, scope);
        console.log(`Enabled ${updated.name}@${updated.version}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  plugin
    .command('disable')
    .description('Disable a plugin')
    .argument('<name>', 'Plugin name')
    .action(async function (this: Command, name: string) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      try {
        const updated = await disablePlugin(conn, name, scope);
        console.log(`Disabled ${updated.name}@${updated.version}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  plugin
    .command('rm')
    .description('Remove a plugin')
    .argument('<name>', 'Plugin name')
    .action(async function (this: Command, name: string) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      try {
        await deletePlugin(conn, name, scope);
        console.log(`Removed ${name}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  plugin
    .command('settings')
    .description('Update plugin settings (non-secret)')
    .argument('<name>', 'Plugin name')
    .argument('<json>', 'Settings JSON object')
    .action(async function (this: Command, name: string, jsonStr: string) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(jsonStr);
      } catch {
        console.error('Invalid JSON for settings');
        process.exit(1);
      }
      try {
        const updated = await updatePluginSettings(conn, name, settings, scope);
        console.log(`Updated settings for ${updated.name}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });
}
