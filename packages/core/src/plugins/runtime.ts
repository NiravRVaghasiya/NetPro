// packages/core/src/plugins/runtime.ts
// Plugin loader, registry, fetch wrapper, capability registry.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqliteConn, PgConn } from '@netpro/db';
import type { WorkspaceScope } from '../workspaces/scope';
import { resolveScope } from '../workspaces/scope';
import { writeActivityLog } from '../crm/activity';
import type { PluginManifest, Plugin, PluginApi, PluginListItem } from './types';
import { validateManifest, satisfiesEngineRange, PluginError } from './manifest';
import { listPlugins, getPluginByName } from './repository';
import type { EnrichmentProvider } from '../enrichment/types';
import type { AiProvider } from '../ai/types';
import type { ContentProvider } from '../content/providers';
import type { EventDiscoveryProvider } from '../events/providers';

type Conn = SqliteConn | PgConn;

const CURRENT_ENGINE_VERSION = '3.0.0'; // matches package version for engine check

// In-memory capability registries per workspace
interface WorkspaceRegistry {
  enrichers: Map<string, EnrichmentProvider>;
  aiProviders: Map<string, AiProvider>;
  contentProviders: Map<string, ContentProvider>;
  eventDiscovery: Map<string, EventDiscoveryProvider>;
  commands: Map<string, { description: string; action: (...args: unknown[]) => unknown }>;
}

const registries = new Map<string, WorkspaceRegistry>();

function getOrCreateRegistry(workspaceId: string): WorkspaceRegistry {
  let reg = registries.get(workspaceId);
  if (!reg) {
    reg = {
      enrichers: new Map(),
      aiProviders: new Map(),
      contentProviders: new Map(),
      eventDiscovery: new Map(),
      commands: new Map(),
    };
    registries.set(workspaceId, reg);
  }
  return reg;
}

export function getPluginRegistry(workspaceId: string): WorkspaceRegistry | undefined {
  return registries.get(workspaceId);
}

export function clearPluginRegistry(workspaceId?: string): void {
  if (workspaceId) registries.delete(workspaceId);
  else registries.clear();
}

// Fetch wrapper enforcing host allowlist
export function createFetchWrapper(allowedHosts: string[] | undefined, workspaceId: string, pluginName: string, conn: Conn, scope: WorkspaceScope) {
  const allowlist = (allowedHosts ?? []).map((h) => h.toLowerCase());

  function isAllowed(urlStr: string): boolean {
    let hostname: string;
    try {
      const u = new URL(urlStr);
      hostname = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    for (const allowed of allowlist) {
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(2);
        if (hostname === suffix || hostname.endsWith('.' + suffix)) return true;
      } else {
        if (hostname === allowed) return true;
      }
    }
    return false;
  }

  return async function pluginFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!isAllowed(url)) {
      // audit blocked attempt
      await writeActivityLog(
        conn,
        {
          action: 'plugin.fetch_blocked',
          entityType: 'plugin',
          entityId: pluginName,
          metadata: { workspaceId, plugin: pluginName, url, allowedHosts: allowlist },
        },
        scope
      );
      throw new PluginError('forbidden', `Fetch to ${url} blocked — host not in plugin permissions.network allowlist.`);
    }
    // Use global fetch
    return fetch(url, init);
  };
}

// Logger with rate cap (simple in-memory per plugin)
const logCounts = new Map<string, { count: number; resetAt: number }>();
const LOG_LIMIT = 100; // per minute per plugin per workspace

function canLog(key: string): boolean {
  const now = Date.now();
  const entry = logCounts.get(key);
  if (!entry || now > entry.resetAt) {
    logCounts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= LOG_LIMIT) return false;
  entry.count++;
  return true;
}

export function createPluginApi(
  manifest: PluginManifest,
  workspaceId: string,
  userId: string,
  conn: Conn,
  scope: WorkspaceScope,
  settings: Record<string, unknown> | null,
  fetchWrapper: (url: string, init?: RequestInit) => Promise<Response>
): PluginApi {
  const registry = getOrCreateRegistry(workspaceId);

  return {
    workspaceId,
    userId,
    fetch: fetchWrapper,
    getSetting(key: string): unknown {
      return settings?.[key] ?? null;
    },
    async getSecret(key: string): Promise<string | null> {
      // Secrets live in key_vault with name plugin.<pluginName>.<key>
      // We need to resolve via vault — import dynamically to avoid cycle
      const { resolveVaultKey } = await import('../crypto/vault');
      const slot = `plugin.${manifest.name}.${key}`;
      try {
        const resolved = await resolveVaultKey(conn, scope, slot);
        return resolved;
      } catch {
        return null;
      }
    },
    log(level, message, meta) {
      const key = `${workspaceId}:${manifest.name}`;
      if (!canLog(key)) return;
      // Best-effort activity log for lifecycle events
      writeActivityLog(
        conn,
        {
          action: `plugin.log.${level}`,
          entityType: 'plugin',
          entityId: manifest.name,
          metadata: { message: message.slice(0, 1000), ...meta },
        },
        scope
      ).catch(() => {});
    },
    registerEnricher(provider) {
      if (!manifest.permissions.capabilities.includes('enricher')) {
        throw new PluginError('forbidden', `Plugin ${manifest.name} does not declare enricher capability.`);
      }
      registry.enrichers.set(provider.id, provider);
    },
    registerAiProvider(provider) {
      if (!manifest.permissions.capabilities.includes('ai-provider')) {
        throw new PluginError('forbidden', `Plugin ${manifest.name} does not declare ai-provider capability.`);
      }
      registry.aiProviders.set(provider.id, provider);
    },
    registerContentProvider(provider) {
      if (!manifest.permissions.capabilities.includes('content-provider')) {
        throw new PluginError('forbidden', `Plugin ${manifest.name} does not declare content-provider capability.`);
      }
      registry.contentProviders.set(provider.id, provider);
    },
    registerEventDiscoveryProvider(provider) {
      if (!manifest.permissions.capabilities.includes('event-discovery')) {
        throw new PluginError('forbidden', `Plugin ${manifest.name} does not declare event-discovery capability.`);
      }
      registry.eventDiscovery.set(provider.name, provider);
    },
    registerCommand(name, description, action) {
      if (!manifest.permissions.capabilities.includes('command')) {
        throw new PluginError('forbidden', `Plugin ${manifest.name} does not declare command capability.`);
      }
      registry.commands.set(`${manifest.name}:${name}`, { description, action });
    },
  };
}

// Discovery: NETPRO_PLUGIN_DIR default ./plugins
export function getPluginDirs(): string[] {
  const envDir = process.env.NETPRO_PLUGIN_DIR?.trim();
  if (envDir) return [envDir];
  // default: ./plugins relative to cwd, plus ./plugins in repo root if exists
  return [path.resolve(/* turbopackIgnore: true */ process.cwd(), 'plugins')];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: Plugin;
  path: string;
  error?: string;
}

export async function discoverPluginsFromDir(dir: string): Promise<LoadedPlugin[]> {
  const results: LoadedPlugin[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results; // dir does not exist
  }

  for (const entry of entries) {
    const fullPath = path.join(/* turbopackIgnore: true */ dir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Look for manifest file
    const manifestPath = path.join(/* turbopackIgnore: true */ fullPath, 'manifest.json');
    let manifestRaw: unknown;
    try {
      const content = await fs.readFile(manifestPath, 'utf8');
      manifestRaw = JSON.parse(content);
    } catch {
      continue; // no manifest
    }

    let manifest: PluginManifest;
    try {
      manifest = validateManifest(manifestRaw);
    } catch (e) {
      results.push({
        manifest: manifestRaw as PluginManifest,
        plugin: null as unknown as Plugin,
        path: fullPath,
        error: (e as Error).message,
      });
      continue;
    }

    // Engine check
    if (!satisfiesEngineRange(CURRENT_ENGINE_VERSION, manifest.engine)) {
      results.push({
        manifest,
        plugin: null as unknown as Plugin,
        path: fullPath,
        error: `Engine mismatch: plugin requires ${manifest.engine} but current is ${CURRENT_ENGINE_VERSION}`,
      });
      continue;
    }

    // Load entry file
    const entryFile = path.join(/* turbopackIgnore: true */ fullPath, manifest.entry ?? 'index.js');
    try {
      // Ensure file exists
      await fs.access(entryFile);
    } catch {
      results.push({
        manifest,
        plugin: null as unknown as Plugin,
        path: fullPath,
        error: `Entry file not found: ${manifest.entry}`,
      });
      continue;
    }

    try {
      const url = pathToFileURL(entryFile).href;
      const mod = await import(url);
      const pluginExport = mod.default ?? mod.plugin ?? mod;
      // Support definePlugin return
      let plugin: Plugin;
      if (pluginExport && typeof pluginExport === 'object' && 'manifest' in pluginExport && 'register' in pluginExport) {
        plugin = pluginExport as Plugin;
      } else if (typeof pluginExport === 'function') {
        // If default export is register function, wrap with manifest
        plugin = { manifest, register: pluginExport as (api: PluginApi) => void };
      } else if (pluginExport && typeof pluginExport.register === 'function') {
        plugin = { manifest, register: pluginExport.register };
      } else {
        throw new Error('Plugin entry must export { manifest, register } or a register function');
      }
      // Validate manifest in entry matches file manifest if both present
      if (plugin.manifest && plugin.manifest.name !== manifest.name) {
        throw new Error(`Manifest name mismatch: file ${manifest.name} vs entry ${plugin.manifest.name}`);
      }
      results.push({ manifest, plugin, path: fullPath });
    } catch (e) {
      results.push({
        manifest,
        plugin: null as unknown as Plugin,
        path: fullPath,
        error: (e as Error).message,
      });
    }
  }

  return results;
}

export async function loadPluginsForWorkspace(conn: Conn, scope?: WorkspaceScope): Promise<{ loaded: LoadedPlugin[]; enabled: PluginListItem[] }> {
  const resolved = resolveScope(scope);
  const enabledPlugins = (await listPlugins(conn, scope)).filter((p) => p.enabled);

  const dirs = getPluginDirs();
  const discovered: LoadedPlugin[] = [];
  for (const dir of dirs) {
    const fromDir = await discoverPluginsFromDir(dir);
    discovered.push(...fromDir);
  }

  // For each enabled plugin in DB, try to find its loaded version
  const loaded: LoadedPlugin[] = [];
  for (const dbPlugin of enabledPlugins) {
    const match = discovered.find((d) => d.manifest.name === dbPlugin.name && !d.error);
    if (!match) {
      // Plugin enabled in DB but not found on disk — log and continue
      await writeActivityLog(
        conn,
        {
          action: 'plugin.load_failed',
          entityType: 'plugin',
          entityId: dbPlugin.name,
          metadata: { reason: 'not_found_on_disk', workspaceId: resolved.workspaceId },
        },
        scope
      );
      continue;
    }
    // Check version matches DB? Allow if manifest version >= DB version? For now require exact or compatible
    // We will use DB version as source of truth, but manifest version should equal
    loaded.push(match);
  }

  // Actually register enabled plugins
  const registry = getOrCreateRegistry(resolved.workspaceId);
  // Clear previous registrations for this workspace to avoid duplicates
  registry.enrichers.clear();
  registry.aiProviders.clear();
  registry.contentProviders.clear();
  registry.eventDiscovery.clear();
  registry.commands.clear();

  for (const lp of loaded) {
    const dbItem = enabledPlugins.find((e) => e.name === lp.manifest.name);
    if (!dbItem) continue;
    try {
      const fetchWrapper = createFetchWrapper(lp.manifest.permissions.network, resolved.workspaceId, lp.manifest.name, conn, resolved);
      const api = createPluginApi(lp.manifest, resolved.workspaceId, resolved.userId, conn, resolved, dbItem.settings, fetchWrapper);
      await lp.plugin.register(api);
      await writeActivityLog(
        conn,
        {
          action: 'plugin.enabled',
          entityType: 'plugin',
          entityId: lp.manifest.name,
          metadata: { version: lp.manifest.version, workspaceId: resolved.workspaceId },
        },
        scope
      );
    } catch (e) {
      // Failing plugin disables itself with logged reason, never takes app down
      await writeActivityLog(
        conn,
        {
          action: 'plugin.load_error',
          entityType: 'plugin',
          entityId: lp.manifest.name,
          metadata: { error: (e as Error).message.slice(0, 500), workspaceId: resolved.workspaceId },
        },
        scope
      );
      // Disable in DB
      try {
        const { updatePluginEnabled } = await import('./repository');
        await updatePluginEnabled(conn, lp.manifest.name, false, scope);
      } catch {
        // ignore
      }
    }
  }

  return { loaded, enabled: enabledPlugins };
}

// CLI helpers
export async function enablePlugin(conn: Conn, name: string, scope?: WorkspaceScope): Promise<PluginListItem> {
  const plugin = await getPluginByName(conn, name, scope);
  if (!plugin) throw new PluginError('not_found', `Plugin ${name} not found. Install it first.`);

  // Discover to validate engine and entry exists before enabling
  const dirs = getPluginDirs();
  let found: LoadedPlugin | undefined;
  for (const dir of dirs) {
    const discovered = await discoverPluginsFromDir(dir);
    found = discovered.find((d) => d.manifest.name === name && !d.error);
    if (found) break;
  }
  if (!found) {
    // Check if error is engine mismatch to give self-explaining error
    for (const dir of dirs) {
      const discovered = await discoverPluginsFromDir(dir);
      const errMatch = discovered.find((d) => d.manifest.name === name && d.error);
      if (errMatch) {
        throw new PluginError('engine_mismatch', errMatch.error!);
      }
    }
    throw new PluginError('not_found', `Plugin ${name} not found on disk in ${dirs.join(', ')}`);
  }

  const { updatePluginEnabled } = await import('./repository');
  const updated = await updatePluginEnabled(conn, name, true, scope);

  await writeActivityLog(
    conn,
    {
      action: 'plugin.enabled',
      entityType: 'plugin',
      entityId: name,
      metadata: { workspaceId: resolveScope(scope).workspaceId, version: plugin.version },
    },
    scope
  );

  // Load the newly enabled plugin into the registry (so enable → capabilities registered)
  try {
    await loadPluginsForWorkspace(conn, scope);
  } catch {
    /* ignore — loadPluginsForWorkspace already audits failures */
  }

  return updated;
}

export async function disablePlugin(conn: Conn, name: string, scope?: WorkspaceScope): Promise<PluginListItem> {
  const plugin = await getPluginByName(conn, name, scope);
  if (!plugin) throw new PluginError('not_found', `Plugin ${name} not found.`);

  const { updatePluginEnabled } = await import('./repository');
  const updated = await updatePluginEnabled(conn, name, false, scope);

  // Clear from registry
  const resolved = resolveScope(scope);
  const reg = getOrCreateRegistry(resolved.workspaceId);
  // Remove any entries that belong to this plugin (best-effort: we clear all and reload remaining enabled)
  reg.enrichers.clear();
  reg.aiProviders.clear();
  reg.contentProviders.clear();
  reg.eventDiscovery.clear();
  reg.commands.clear();

  await writeActivityLog(
    conn,
    {
      action: 'plugin.disabled',
      entityType: 'plugin',
      entityId: name,
      metadata: { workspaceId: resolved.workspaceId },
    },
    scope
  );

  // Reload remaining enabled plugins
  await loadPluginsForWorkspace(conn, scope);

  return updated;
}
