// packages/core/src/plugins/runtime.test.ts
// v3.0 Phase 5 — permission enforcement, data boundary, lifecycle.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { createPlugin, listPlugins } from './repository';
import { createFetchWrapper, clearPluginRegistry, getPluginRegistry, discoverPluginsFromDir, loadPluginsForWorkspace, enablePlugin, disablePlugin } from './runtime';
import { validateManifest } from './manifest';
import type { WorkspaceScope } from '../workspaces/scope';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const scopeA: WorkspaceScope = { workspaceId: 'default', userId: 'user-a', role: 'owner' };
const scopeB: WorkspaceScope = { workspaceId: 'other-ws', userId: 'user-b', role: 'owner' };

describe('plugin fetch permission enforcement (Phase 5)', () => {
  let fixture: ReturnType<typeof createTestSqliteConn>;

  beforeEach(() => {
    fixture = createTestSqliteConn();
    clearPluginRegistry();
  });
  afterEach(() => {
    clearPluginRegistry();
  });


  it('blocks fetch to undeclared host and audits', async () => {
    const manifest = validateManifest({
      name: 'test-plugin',
      version: '1.0.0',
      engine: '^3.0.0',
      permissions: { capabilities: ['event-discovery'], network: ['api.example.com'] },
    });

    const wrapper = createFetchWrapper(manifest.permissions.network, scopeA.workspaceId, manifest.name, fixture.conn, scopeA);

    await expect(wrapper('https://evil.com/steal')).rejects.toThrow(/blocked/);

    // Check audit log
    const logs = fixture.sqlite.prepare('SELECT action, entity_id FROM activity_log').all() as Array<{ action: string; entity_id: string }>;
    expect(logs.some((l) => l.action === 'plugin.fetch_blocked' && l.entity_id === 'test-plugin')).toBe(true);
  });

  it('allows fetch to declared exact host', async () => {
    const manifest = validateManifest({
      name: 'test-plugin',
      version: '1.0.0',
      engine: '^3.0.0',
      permissions: { capabilities: ['event-discovery'], network: ['api.example.com'] },
    });

    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    try {
      const wrapper = createFetchWrapper(manifest.permissions.network, scopeA.workspaceId, manifest.name, fixture.conn, scopeA);
      const res = await wrapper('https://api.example.com/data');
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('allows wildcard subdomain', async () => {
    const manifest = validateManifest({
      name: 'test-plugin',
      version: '1.0.0',
      engine: '^3.0.0',
      permissions: { capabilities: ['event-discovery'], network: ['*.example.com'] },
    });

    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    try {
      const wrapper = createFetchWrapper(manifest.permissions.network, scopeA.workspaceId, manifest.name, fixture.conn, scopeA);
      await wrapper('https://api.example.com/data');
      await wrapper('https://sub.api.example.com/data');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await expect(wrapper('https://example.com.evil.com/data')).rejects.toThrow(/blocked/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe('plugin data boundary (Phase 5)', () => {
  let fixture: ReturnType<typeof createTestSqliteConn>;

  beforeEach(() => {
    fixture = createTestSqliteConn();
    clearPluginRegistry();
    // seed other workspace — default already exists via migration 0008 INSERT OR IGNORE
    try {
      fixture.conn.db.insert(fixture.conn.schema.workspaces).values({ id: 'other-ws', name: 'Other', slug: 'other' }).run();
    } catch {
      /* ignore if exists */
    }
  });
  afterEach(() => {
    clearPluginRegistry();
  });


  it('listPlugins is workspace-scoped', async () => {
    await createPlugin(
      fixture.conn,
      {
        name: 'plugin-a',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'plugin-a',
          version: '1.0.0',
          engine: '^3.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
      },
      scopeA
    );

    await createPlugin(
      fixture.conn,
      {
        name: 'plugin-b',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'plugin-b',
          version: '1.0.0',
          engine: '^3.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
      },
      scopeB
    );

    const listA = await listPlugins(fixture.conn, scopeA);
    const listB = await listPlugins(fixture.conn, scopeB);

    expect(listA.map((p) => p.name)).toEqual(['plugin-a']);
    expect(listB.map((p) => p.name)).toEqual(['plugin-b']);
  });

  it('injected API cannot reach another workspace (scope guard)', async () => {
    // Simulate plugin trying to use crafted workspace id — our repository always uses resolveScope
    // So even if plugin passes other workspace id, it should be ignored.
    // Here we test that listPlugins with scopeA never returns B's rows even if plugin tries to craft.
    await createPlugin(
      fixture.conn,
      {
        name: 'plugin-a',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'plugin-a',
          version: '1.0.0',
          engine: '^3.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
      },
      scopeB
    );

    const listA = await listPlugins(fixture.conn, scopeA);
    expect(listA.length).toBe(0);
  });
});

describe('plugin lifecycle (Phase 5)', () => {
  let fixture: ReturnType<typeof createTestSqliteConn>;
  let tmpDir: string;

  beforeEach(() => {
    fixture = createTestSqliteConn();
    clearPluginRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), 'netpro-plugins-'));
    process.env.NETPRO_PLUGIN_DIR = tmpDir;
  });

  afterEach(() => {
    clearPluginRegistry();
    delete process.env.NETPRO_PLUGIN_DIR;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('enable → capabilities registered; disable → unregistered', async () => {
    // Create a simple plugin on disk
    const pluginDir = join(tmpDir, 'test-lifecycle');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        name: 'test-lifecycle',
        version: '1.0.0',
        engine: '^3.0.0',
        permissions: { capabilities: ['event-discovery'] },
      })
    );
    await fs.writeFile(
      join(pluginDir, 'index.js'),
      `
      export const manifest = { name: 'test-lifecycle', version: '1.0.0', engine: '^3.0.0', permissions: { capabilities: ['event-discovery'] } };
      export function register(api) {
        api.registerEventDiscoveryProvider({ name: 'test', enabled: true, discover: async () => [] });
      }
      `
    );

    // Install in DB
    await createPlugin(
      fixture.conn,
      {
        name: 'test-lifecycle',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'test-lifecycle',
          version: '1.0.0',
          engine: '^3.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
        installedFrom: pluginDir,
      },
      scopeA
    );

    // Enable
    await enablePlugin(fixture.conn, 'test-lifecycle', scopeA);
    const reg = getPluginRegistry(scopeA.workspaceId);
    expect(reg?.eventDiscovery.has('test')).toBe(true);

    // Disable
    await disablePlugin(fixture.conn, 'test-lifecycle', scopeA);
    const reg2 = getPluginRegistry(scopeA.workspaceId);
    expect(reg2?.eventDiscovery.has('test')).toBe(false);
  });

  it('crashing plugin is isolated and disabled', async () => {
    const pluginDir = join(tmpDir, 'crash-plugin');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        name: 'crash-plugin',
        version: '1.0.0',
        engine: '^3.0.0',
        permissions: { capabilities: ['event-discovery'] },
      })
    );
    await fs.writeFile(
      join(pluginDir, 'index.js'),
      `
      export const manifest = { name: 'crash-plugin', version: '1.0.0', engine: '^3.0.0', permissions: { capabilities: ['event-discovery'] } };
      export function register(api) { throw new Error('boom'); }
      `
    );

    await createPlugin(
      fixture.conn,
      {
        name: 'crash-plugin',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'crash-plugin',
          version: '1.0.0',
          engine: '^3.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
        installedFrom: pluginDir,
      },
      scopeA
    );

    await enablePlugin(fixture.conn, 'crash-plugin', scopeA);

    // loadPluginsForWorkspace should catch and disable
    await loadPluginsForWorkspace(fixture.conn, scopeA);

    const { getPluginByName } = await import('./repository');
    const after = await getPluginByName(fixture.conn, 'crash-plugin', scopeA);
    expect(after?.enabled).toBe(false);

    const logs = fixture.sqlite.prepare("SELECT action FROM activity_log WHERE entity_id = 'crash-plugin'").all() as Array<{ action: string }>;
    expect(logs.some((l) => l.action === 'plugin.load_error')).toBe(true);
  });

  it('engine mismatch is rejected with self-explaining error', async () => {
    const pluginDir = join(tmpDir, 'old-engine');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        name: 'old-engine',
        version: '1.0.0',
        engine: '^2.0.0',
        permissions: { capabilities: ['event-discovery'] },
      })
    );
    await fs.writeFile(join(pluginDir, 'index.js'), `export const manifest = { name: 'old-engine', version: '1.0.0', engine: '^2.0.0', permissions: { capabilities: ['event-discovery'] } }; export function register() {}`);

    await createPlugin(
      fixture.conn,
      {
        name: 'old-engine',
        version: '1.0.0',
        manifest: validateManifest({
          name: 'old-engine',
          version: '1.0.0',
          engine: '^2.0.0',
          permissions: { capabilities: ['event-discovery'] },
        }),
        installedFrom: pluginDir,
      },
      scopeA
    );

    await expect(enablePlugin(fixture.conn, 'old-engine', scopeA)).rejects.toThrow(/Engine mismatch/);
  });
});

describe('plugin discovery adversarial (Phase 5)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'netpro-plugins-adv-'));
    process.env.NETPRO_PLUGIN_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.NETPRO_PLUGIN_DIR;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('ignores directory without manifest', async () => {
    const dir = join(tmpDir, 'no-manifest');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'index.js'), 'export function register() {}');
    const discovered = await discoverPluginsFromDir(tmpDir);
    expect(discovered.length).toBe(0);
  });

  it('reports error for entry that throws', async () => {
    const dir = join(tmpDir, 'throws');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'throws', version: '1.0.0', engine: '^3.0.0', permissions: { capabilities: ['event-discovery'] } }));
    await fs.writeFile(join(dir, 'index.js'), `throw new Error('load fail');`);
    const discovered = await discoverPluginsFromDir(tmpDir);
    expect(discovered[0]?.error).toMatch(/load fail/);
  });
});
