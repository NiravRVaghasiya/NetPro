// apps/cli/src/commands/plugin-marketplace.test.ts
// v3.0 Phase 6 — CLI marketplace executors against fixture indexes (file://,
// no network) and a scratch plugin directory.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  fixtureEntry,
  fixtureIndex,
  fixtureTarGz,
  sha256Hex,
} from '@netpro/core/src/plugins/testing';
import { getPluginByName } from '@netpro/core/src/plugins/repository';
import {
  isLocalManifestPath,
  formatMarketplaceEntry,
  formatPermissionsReview,
  executePluginSearch,
  executePluginMarketplaceInstall,
  executePluginUpdate,
} from './plugin';

const fixture = createTestSqliteConn();
const scope = { workspaceId: 'default', userId: 'cli-tester', role: 'owner' } as const;

let savedCachePath: string | undefined;

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  savedCachePath = process.env.MARKETPLACE_CACHE_PATH;
  process.env.MARKETPLACE_CACHE_PATH = join(mkdtempSync(join(tmpdir(), 'netpro-cli-cache-')), 'cache.json');
});

afterEach(() => {
  fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  if (savedCachePath === undefined) delete process.env.MARKETPLACE_CACHE_PATH;
  else process.env.MARKETPLACE_CACHE_PATH = savedCachePath;
});

describe('plugin marketplace helpers (Phase 6)', () => {
  it('distinguishes local manifest paths from marketplace names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-cli-islocal-'));
    try {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, '{}', 'utf8');
      expect(isLocalManifestPath(file)).toBe(true);
      expect(isLocalManifestPath('example-event-discovery')).toBe(false);
      expect(isLocalManifestPath(join(dir, 'missing.json'))).toBe(false);
      expect(isLocalManifestPath(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats entries and permission reviews for humans', () => {
    const entry = fixtureEntry({ name: 'demo', network: ['api.demo.invalid'] });
    const text = formatMarketplaceEntry(entry);
    expect(text).toContain('demo@1.0.0');
    expect(text).toContain('capabilities: command');
    expect(text).toContain('network: api.demo.invalid');
    const review = formatPermissionsReview('demo', '1.0.0', { capabilities: ['command'], network: [] }, '^3.0.0');
    expect(review).toContain('Permissions for demo@1.0.0');
    expect(review).toContain('engine: ^3.0.0');
  });
});

describe('plugin marketplace executors (Phase 6)', () => {
  function setupIndex(): { dir: string; indexUrl: string; tarballName: string } {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-cli-market-'));
    const tarballName = `cli-plugin-${process.pid}`;
    const tgz = fixtureTarGz({ name: tarballName });
    const tarballFile = join(dir, 'plugin.tgz');
    writeFileSync(tarballFile, tgz);
    const entry = fixtureEntry({
      name: tarballName,
      description: 'CLI fixture plugin',
      url: pathToFileURL(tarballFile).href,
      sha256: sha256Hex(tgz),
    });
    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, JSON.stringify(fixtureIndex([entry])), 'utf8');
    return { dir, indexUrl: pathToFileURL(indexFile).href, tarballName };
  }

  it('searches a file index without network', async () => {
    const { dir, indexUrl } = setupIndex();
    try {
      const all = await executePluginSearch(undefined, { indexUrl });
      expect(all.entries).toHaveLength(1);
      expect(all.fromCache).toBe(false);
      const match = await executePluginSearch('cli fixture', { indexUrl });
      expect(match.entries).toHaveLength(1);
      expect(match.fromCache).toBe(true); // second read served from the local cache
      const none = await executePluginSearch('nope', { indexUrl });
      expect(none.entries).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs then reports up-to-date on update', async () => {
    const { dir, indexUrl, tarballName } = setupIndex();
    const pluginDir = join(dir, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    try {
      const installed = await executePluginMarketplaceInstall(fixture.conn, scope, tarballName, {
        indexUrl,
        pluginDir,
      });
      expect(installed.plugin.enabled).toBe(false);
      expect(existsSync(join(pluginDir, tarballName, 'manifest.json'))).toBe(true);
      expect(await getPluginByName(fixture.conn, tarballName, scope)).not.toBeNull();

      const updated = await executePluginUpdate(fixture.conn, scope, tarballName, { indexUrl, pluginDir });
      expect(updated.updated).toBe(false);
      expect(updated.plugin.version).toBe('1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces install failures as plain errors', async () => {
    const { dir, indexUrl } = setupIndex();
    try {
      await expect(
        executePluginMarketplaceInstall(fixture.conn, scope, 'ghost', { indexUrl, pluginDir: join(dir, 'p') })
      ).rejects.toThrow(/not in the marketplace index/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
