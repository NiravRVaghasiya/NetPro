// apps/cli/src/commands/plugin.ts
// v3.0 Phase 5 — plugin lifecycle CLI. Phase 6 adds the marketplace:
// search/install/update from a static index (checksum-verified, landing
// disabled behind the permissions review gate), and rm removes files too.

import { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  listPlugins,
  getPluginByName,
  createPlugin,
  updatePluginSettings,
} from '@netpro/core/src/plugins/repository';
import {
  enablePlugin,
  disablePlugin,
  getPluginDirs,
  discoverPluginsFromDir,
} from '@netpro/core/src/plugins/runtime';
import { validateManifest } from '@netpro/core/src/plugins/manifest';
import {
  fetchMarketplaceIndex,
  searchMarketplace,
  installPluginFromMarketplace,
  updatePluginFromMarketplace,
  uninstallPlugin,
  type FetchImpl,
  type MarketplaceEntry,
} from '@netpro/core/src/plugins/marketplace';
import type { WorkspaceScope } from '@netpro/core/src/workspaces/scope';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type Conn = SqliteConn | PgConn;

function formatPluginLine(p: { name: string; version: string; enabled: boolean; installedFrom: string | null }) {
  const status = p.enabled ? 'enabled' : 'disabled';
  const src = p.installedFrom ? ` from ${p.installedFrom}` : '';
  return `${p.name}@${p.version} [${status}]${src}`;
}

// ── Phase 6: marketplace helpers (exported for tests) ───────────────────────

/** A marketplace name vs a local manifest path: existing files stay local. */
export function isLocalManifestPath(arg: string): boolean {
  try {
    return existsSync(arg) && statSync(arg).isFile();
  } catch {
    return false;
  }
}

export function formatMarketplaceEntry(entry: MarketplaceEntry): string {
  const capabilities = entry.manifest.permissions.capabilities.join(', ');
  const network = (entry.manifest.permissions.network ?? []).join(', ') || '(none)';
  const source =
    entry.source.type === 'tarball'
      ? entry.source.url
      : `${entry.source.url}#${entry.source.commit.slice(0, 12)}`;
  return [
    `${entry.name}@${entry.version} — ${entry.description}`,
    `  capabilities: ${capabilities}`,
    `  network: ${network}`,
    `  source: ${entry.source.type} ${source}`,
  ].join('\n');
}

export function formatPermissionsReview(
  name: string,
  version: string,
  permissions: { capabilities: string[]; network?: string[] },
  engine: string
): string {
  return [
    `Permissions for ${name}@${version}:`,
    `  capabilities: ${permissions.capabilities.join(', ')}`,
    `  network: ${(permissions.network ?? []).join(', ') || '(none)'}`,
    `  engine: ${engine}`,
  ].join('\n');
}

export async function executePluginSearch(
  term: string | undefined,
  opts: { indexUrl?: string; refresh?: boolean; fetchImpl?: FetchImpl } = {}
): Promise<{ indexUrl: string; fromCache: boolean; entries: MarketplaceEntry[] }> {
  const { index, indexUrl, fromCache } = await fetchMarketplaceIndex({
    indexUrl: opts.indexUrl,
    refresh: opts.refresh,
    fetchImpl: opts.fetchImpl,
  });
  return { indexUrl, fromCache, entries: searchMarketplace(index, term) };
}

export async function executePluginMarketplaceInstall(
  conn: Conn,
  scope: WorkspaceScope | undefined,
  name: string,
  opts: { indexUrl?: string; refresh?: boolean; pluginDir?: string; fetchImpl?: FetchImpl } = {}
) {
  return installPluginFromMarketplace(conn, name, {
    scope,
    indexUrl: opts.indexUrl,
    refresh: opts.refresh,
    pluginDir: opts.pluginDir,
    fetchImpl: opts.fetchImpl,
  });
}

export async function executePluginUpdate(
  conn: Conn,
  scope: WorkspaceScope | undefined,
  name: string,
  opts: { indexUrl?: string; refresh?: boolean; pluginDir?: string; force?: boolean; fetchImpl?: FetchImpl } = {}
) {
  return updatePluginFromMarketplace(conn, name, {
    scope,
    indexUrl: opts.indexUrl,
    refresh: opts.refresh,
    pluginDir: opts.pluginDir,
    force: opts.force,
    fetchImpl: opts.fetchImpl,
  });
}

export function registerPluginCommand(program: Command) {
  const plugin = program.command('plugin').description('Manage NetPro plugins (v3.0 Phase 5–6)');

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
    .command('search')
    .description('Search the plugin marketplace (static index, no telemetry)')
    .argument('[term]', 'Search term (empty lists all)')
    .option('--json', 'JSON output')
    .option('--refresh', 'Bypass the local index cache')
    .action(async (term: string | undefined, opts) => {
      try {
        const result = await executePluginSearch(term, { refresh: opts.refresh });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Marketplace index: ${result.indexUrl}${result.fromCache ? ' (cached)' : ''}`);
        if (result.entries.length === 0) {
          console.log(term ? `No plugins match ${JSON.stringify(term)}.` : 'The marketplace index is empty.');
          return;
        }
        for (const entry of result.entries) {
          console.log(formatMarketplaceEntry(entry));
        }
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
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
    .description('Install a plugin: a marketplace <name>, or a local <manifest.json> path')
    .argument('<nameOrManifest>', 'Marketplace plugin name, or path to a local manifest.json')
    .option('--from <path>', 'Installed-from label (local installs only)')
    .option('--refresh', 'Bypass the local index cache (marketplace installs)')
    .option('--json', 'JSON output')
    .action(async function (this: Command, nameOrManifest: string, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      if (!isLocalManifestPath(nameOrManifest)) {
        // Marketplace install: checksum-verified, registered disabled.
        try {
          const result = await executePluginMarketplaceInstall(conn, scope, nameOrManifest, {
            refresh: opts.refresh,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(`Installed ${result.plugin.name}@${result.plugin.version} (disabled by default).`);
          console.log(
            formatPermissionsReview(
              result.plugin.name,
              result.plugin.version,
              result.plugin.manifest.permissions,
              result.plugin.manifest.engine
            )
          );
          console.log(
            `Review the permissions above, then run: netpro plugin enable ${result.plugin.name} --i-have-reviewed-permissions`
          );
        } catch (e) {
          console.error((e as Error).message);
          process.exit(1);
        }
        return;
      }
      const fullPath = resolve(nameOrManifest);
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
    .command('update')
    .description('Update a plugin from the marketplace (monotonic: downgrades refused unless --force)')
    .argument('<name>', 'Plugin name')
    .option('--force', 'Allow downgrades')
    .option('--refresh', 'Bypass the local index cache')
    .option('--json', 'JSON output')
    .action(async function (this: Command, name: string, opts) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      try {
        const result = await executePluginUpdate(conn, scope, name, {
          force: opts.force,
          refresh: opts.refresh,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.updated) {
          console.log(`${result.plugin.name}@${result.plugin.version} is already up to date.`);
          return;
        }
        console.log(`Updated ${result.plugin.name}@${result.fromVersion} → ${result.plugin.version}.`);
        if (result.plugin.enabled) console.log('The plugin was enabled; its new code is now loaded.');
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
    .description('Remove a plugin (unregisters and deletes its files)')
    .argument('<name>', 'Plugin name')
    .action(async function (this: Command, name: string) {
      const { openDb, resolveCliScope } = await import('../db');
      const conn = (await openDb()) as Conn;
      const scope = await resolveCliScope(this, conn);
      try {
        const result = await uninstallPlugin(conn, name, { scope });
        console.log(result.filesRemoved ? `Removed ${name} (files deleted).` : `Removed ${name} (no files on disk).`);
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
