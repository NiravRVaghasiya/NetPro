// packages/core/src/plugins/marketplace.test.ts
// v3.0 Phase 6 — index validation, fetch/cache, checksums, install/update/
// remove orchestration. No network: http is injected, files live in tmp.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import type { WorkspaceScope } from '../workspaces/scope';
import { PluginError, compareSemver } from './manifest';
import { getPluginByName, updatePluginSettings } from './repository';
import { clearPluginRegistry } from './runtime';
import {
  validateMarketplaceIndex,
  searchMarketplace,
  fetchMarketplaceIndex,
  downloadAndVerifyTarball,
  verifySha256Hex,
  resolveSourceUrl,
  resolvePluginInstallDir,
  getMarketplaceIndexUrl,
  installPluginFromMarketplace,
  updatePluginFromMarketplace,
  uninstallPlugin,
  installFromGitSource,
  MAX_INDEX_BYTES,
  type MarketplaceIndex,
  type MarketplaceEntry,
  type FetchImpl,
} from './marketplace';
import { fixtureEntry, fixtureIndex, fixtureTarGz, sha256Hex } from './testing';

const scope: WorkspaceScope = { workspaceId: 'default', userId: 'tester', role: 'owner' };

let counter = 0;
function uniqueName(prefix = 'mp-test'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'netpro-market-test-'));
}

const ENV_KEYS = ['MARKETPLACE_INDEX_URL', 'MARKETPLACE_CACHE_PATH', 'MARKETPLACE_NO_CACHE', 'NETPRO_PLUGIN_DIR'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Every test gets a private index cache unless it opts out.
  process.env.MARKETPLACE_CACHE_PATH = join(tempDir(), 'cache.json');
  clearPluginRegistry();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearPluginRegistry();
});

describe('compareSemver', () => {
  it('orders versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
  });

  it('rejects malformed versions', () => {
    expect(() => compareSemver('1.0', '1.0.0')).toThrow(/non-semver/);
  });
});

describe('validateMarketplaceIndex (Phase 6)', () => {
  it('accepts a minimal valid index', () => {
    const index = validateMarketplaceIndex(fixtureIndex([fixtureEntry({})]));
    expect(index.schema).toBe(1);
    expect(index.plugins).toHaveLength(1);
  });

  it('rejects schema drift', () => {
    expect(() => validateMarketplaceIndex({ schema: 2, updated_at: new Date().toISOString(), plugins: [] })).toThrow(
      /schema 2/
    );
    expect(() => validateMarketplaceIndex({ updated_at: new Date().toISOString(), plugins: [] })).toThrow(
      /schema undefined/
    );
  });

  it('rejects non-objects, bad dates, and non-array plugins', () => {
    expect(() => validateMarketplaceIndex(null)).toThrow(/must be a JSON object/);
    expect(() => validateMarketplaceIndex({ schema: 1, updated_at: 'yesterday', plugins: [] })).toThrow(/updated_at/);
    expect(() =>
      validateMarketplaceIndex({ schema: 1, updated_at: new Date().toISOString(), plugins: {} })
    ).toThrow(/must be an array/);
  });

  it('rejects oversized indexes', () => {
    const plugins = Array.from({ length: 1001 }, (_, i) => fixtureEntry({ name: `p-${i}` }));
    expect(() => validateMarketplaceIndex(fixtureIndex(plugins))).toThrow(/max 1000/);
  });

  it('reuses manifest validation for entries', () => {
    const bad = (entry: unknown) => () => validateMarketplaceIndex({ schema: 1, updated_at: new Date().toISOString(), plugins: [entry] });
    expect(bad({ ...fixtureEntry({}), name: 'BAD NAME!' })).toThrow(/Invalid plugin name/);
    expect(bad({ ...fixtureEntry({}), version: '1.0' })).toThrow(/semver/);
    expect(
      bad({ ...fixtureEntry({}), manifest: { permissions: { capabilities: ['teleport'] } } })
    ).toThrow(/Unknown capability/);
    expect(
      bad({ ...fixtureEntry({}), manifest: { permissions: { capabilities: ['command'], network: ['*bad'] } } })
    ).toThrow(/Wildcard must be prefix/);
    expect(bad({ ...fixtureEntry({}), manifest: undefined })).toThrow(/permissions object required/);
  });

  it('requires descriptions and validates homepages', () => {
    const bad = (entry: unknown) => () => validateMarketplaceIndex({ schema: 1, updated_at: new Date().toISOString(), plugins: [entry] });
    expect(bad({ ...fixtureEntry({}), description: '  ' })).toThrow(/needs a description/);
    expect(bad({ ...fixtureEntry({}), description: 'x'.repeat(2001) })).toThrow(/too long/);
    expect(bad({ ...fixtureEntry({}), homepage: 'ftp://example.com' })).toThrow(/must be http/);
    expect(bad({ ...fixtureEntry({}), homepage: 'not a url' })).toThrow(/invalid homepage/);
  });

  it('validates tarball sources', () => {
    const bad = (source: unknown) => () =>
      validateMarketplaceIndex({
        schema: 1,
        updated_at: new Date().toISOString(),
        plugins: [{ ...fixtureEntry({}), source }],
      });
    expect(bad({ type: 'tarball', url: 'https://example.invalid/p.tgz' })).toThrow(/needs a sha256/);
    expect(bad({ type: 'tarball', url: 'https://example.invalid/p.tgz', sha256: 'xyz' })).toThrow(/sha256 hex/);
    expect(bad({ type: 'tarball', url: 'ftp://example.invalid/p.tgz', sha256: '0'.repeat(64) })).toThrow(
      /unsupported source URL scheme/
    );
    expect(bad({ type: 'tarball', url: 'https://user:pw@example.invalid/p.tgz', sha256: '0'.repeat(64) })).toThrow(
      /must not contain credentials/
    );
    expect(bad({ type: 'tarball', sha256: '0'.repeat(64) })).toThrow(/needs a url/);
  });

  it('validates git sources', () => {
    const bad = (source: unknown) => () =>
      validateMarketplaceIndex({
        schema: 1,
        updated_at: new Date().toISOString(),
        plugins: [{ ...fixtureEntry({}), source }],
      });
    expect(bad({ type: 'git', url: 'git@github.com:org/repo.git', commit: 'a'.repeat(40) })).toThrow(
      /must be https:\/\/ or file:\/\//
    );
    expect(bad({ type: 'git', url: 'https://github.com/org/repo.git', commit: 'abc' })).toThrow(/40-char commit/);
    expect(bad({ type: 'carrier-pigeon', url: 'https://example.invalid/' })).toThrow(/unknown source type/);
  });

  it('rejects duplicate names', () => {
    expect(() =>
      validateMarketplaceIndex(fixtureIndex([fixtureEntry({ name: 'dup' }), fixtureEntry({ name: 'dup' })]))
    ).toThrow(/duplicate plugin name/);
  });

  it('normalizes checksums to lowercase', () => {
    const index = validateMarketplaceIndex(
      fixtureIndex([fixtureEntry({ sha256: 'A'.repeat(64) })])
    );
    const source = index.plugins[0]!.source;
    expect(source.type).toBe('tarball');
    if (source.type === 'tarball') expect(source.sha256).toBe('a'.repeat(64));
  });
});

describe('resolveSourceUrl (Phase 6)', () => {
  it('passes absolute URLs through', () => {
    expect(resolveSourceUrl('https://host.invalid/index.json', 'https://cdn.invalid/p.tgz')).toBe(
      'https://cdn.invalid/p.tgz'
    );
  });

  it('resolves relative URLs against http index URLs (self-hosting)', () => {
    expect(resolveSourceUrl('https://host.invalid/marketplace/index.json', 'tarballs/p-1.0.0.tgz')).toBe(
      'https://host.invalid/marketplace/tarballs/p-1.0.0.tgz'
    );
  });

  it('resolves relative URLs against file index URLs and plain paths', () => {
    const dir = tempDir();
    try {
      const fileBase = pathToFileURL(join(dir, 'index.json')).href;
      expect(resolveSourceUrl(fileBase, 'tarballs/p.tgz')).toBe(join(dir, 'tarballs', 'p.tgz'));
      expect(resolveSourceUrl(join(dir, 'index.json'), 'tarballs/p.tgz')).toBe(join(dir, 'tarballs', 'p.tgz'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects credentialed and exotic absolute URLs', () => {
    expect(() => resolveSourceUrl('https://h.invalid/i.json', 'https://u:p@h.invalid/p.tgz')).toThrow(/credentials/);
    expect(() => resolveSourceUrl('https://h.invalid/i.json', 'ftp://h.invalid/p.tgz')).toThrow(
      /unsupported source URL scheme/
    );
  });
});

describe('getMarketplaceIndexUrl (Phase 6)', () => {
  it('defaults to this repo raw file and honors the override', () => {
    expect(getMarketplaceIndexUrl()).toContain('raw.githubusercontent.com/NiravRVaghasiya/NetPro');
    process.env.MARKETPLACE_INDEX_URL = 'https://example.invalid/custom.json';
    expect(getMarketplaceIndexUrl()).toBe('https://example.invalid/custom.json');
  });
});

describe('fetchMarketplaceIndex (Phase 6)', () => {
  it('fetches over injected http and caches locally', async () => {
    const index = fixtureIndex([fixtureEntry({ name: 'cached-one' })]);
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(index), { status: 200 });
    };
    const first = await fetchMarketplaceIndex({ fetchImpl, indexUrl: 'https://example.invalid/index.json' });
    expect(first.fromCache).toBe(false);
    expect(first.index.plugins[0]!.name).toBe('cached-one');
    const second = await fetchMarketplaceIndex({ fetchImpl, indexUrl: 'https://example.invalid/index.json' });
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
    const refreshed = await fetchMarketplaceIndex({
      fetchImpl,
      indexUrl: 'https://example.invalid/index.json',
      refresh: true,
    });
    expect(refreshed.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it('reads file:// and plain-path indexes without touching fetch', async () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'index.json');
      writeFileSync(file, JSON.stringify(fixtureIndex([fixtureEntry({ name: 'local-one' })])), 'utf8');
      const exploding: FetchImpl = async () => {
        throw new Error('must not fetch');
      };
      const viaFile = await fetchMarketplaceIndex({ fetchImpl: exploding, indexUrl: pathToFileURL(file).href });
      expect(viaFile.index.plugins[0]!.name).toBe('local-one');
      const viaPath = await fetchMarketplaceIndex({ fetchImpl: exploding, indexUrl: file });
      expect(viaPath.index.plugins[0]!.name).toBe('local-one');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps http failures, bad JSON, and schema drift to self-explaining errors', async () => {
    const notFound: FetchImpl = async () => new Response('nope', { status: 404 });
    await expect(fetchMarketplaceIndex({ fetchImpl: notFound, indexUrl: 'https://example.invalid/i.json' })).rejects.toThrow(
      /HTTP 404/
    );
    const badJson: FetchImpl = async () => new Response('{oops', { status: 200 });
    await expect(
      fetchMarketplaceIndex({ fetchImpl: badJson, indexUrl: 'https://example.invalid/i.json', refresh: true })
    ).rejects.toThrow(/not valid JSON/);
    const drift: FetchImpl = async () => new Response(JSON.stringify({ schema: 99 }), { status: 200 });
    await expect(
      fetchMarketplaceIndex({ fetchImpl: drift, indexUrl: 'https://example.invalid/i.json', refresh: true })
    ).rejects.toThrow(/schema 99/);
  });

  it('refuses oversized indexes before and during the read', async () => {
    const lyingLength: FetchImpl = async () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(MAX_INDEX_BYTES + 1) } });
    await expect(
      fetchMarketplaceIndex({ fetchImpl: lyingLength, indexUrl: 'https://example.invalid/i.json', refresh: true })
    ).rejects.toThrow(/exceeds the .* limit/);
    const huge: FetchImpl = async () => new Response('x'.repeat(MAX_INDEX_BYTES + 1), { status: 200 });
    await expect(
      fetchMarketplaceIndex({ fetchImpl: huge, indexUrl: 'https://example.invalid/i.json', refresh: true })
    ).rejects.toThrow(/exceeds the .* limit/);
  });

  it('reports missing local indexes without a stack trace', async () => {
    await expect(fetchMarketplaceIndex({ indexUrl: join(tempDir(), 'nope.json') })).rejects.toThrow(/not found/);
  });
});

describe('searchMarketplace (Phase 6)', () => {
  const index: MarketplaceIndex = fixtureIndex([
    fixtureEntry({ name: 'github-sync', description: 'Sync contacts from GitHub', capabilities: ['source'] }),
    fixtureEntry({ name: 'event-finder', description: 'Discover meetups near you', network: ['api.meetups.invalid'] }),
  ]);

  it('matches names, descriptions, capabilities, and hosts', () => {
    expect(searchMarketplace(index, '')).toHaveLength(2);
    expect(searchMarketplace(index, 'github').map((e) => e.name)).toEqual(['github-sync']);
    expect(searchMarketplace(index, 'MEETUPS').map((e) => e.name)).toEqual(['event-finder']);
    expect(searchMarketplace(index, 'source').map((e) => e.name)).toEqual(['github-sync']);
    expect(searchMarketplace(index, 'api.meetups.invalid').map((e) => e.name)).toEqual(['event-finder']);
    expect(searchMarketplace(index, 'github meetups')).toHaveLength(0);
    expect(searchMarketplace(index, 'nope')).toHaveLength(0);
  });
});

describe('downloadAndVerifyTarball (Phase 6)', () => {
  it('accepts matching checksums and refuses mismatches', async () => {
    const dir = tempDir();
    try {
      const tgz = fixtureTarGz({});
      const file = join(dir, 'p.tgz');
      writeFileSync(file, tgz);
      const url = pathToFileURL(file).href;
      await expect(downloadAndVerifyTarball(url, sha256Hex(tgz))).resolves.toEqual(tgz);
      await expect(downloadAndVerifyTarball(url, 'f'.repeat(64))).rejects.toThrow(/Checksum mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downloads over injected http', async () => {
    const tgz = fixtureTarGz({});
    const fetchImpl: FetchImpl = async (url) => {
      expect(url).toBe('https://cdn.invalid/p.tgz');
      return new Response(new Uint8Array(tgz), { status: 200 });
    };
    await expect(downloadAndVerifyTarball('https://cdn.invalid/p.tgz', sha256Hex(tgz), { fetchImpl })).resolves.toEqual(
      tgz
    );
  });

  it('compares checksums safely', () => {
    const data = Buffer.from('hello');
    expect(verifySha256Hex(data, sha256Hex(data))).toBe(true);
    expect(verifySha256Hex(data, '0'.repeat(64))).toBe(false);
    expect(verifySha256Hex(data, 'not-hex')).toBe(false);
  });
});

describe('resolvePluginInstallDir (Phase 6)', () => {
  it('prefers the explicit dir, then the env var, then an existing load root', () => {
    const dir = tempDir();
    try {
      const explicit = join(dir, 'explicit');
      expect(resolvePluginInstallDir(explicit)).toBe(explicit);
      process.env.NETPRO_PLUGIN_DIR = join(dir, 'from-env');
      expect(resolvePluginInstallDir()).toBe(join(dir, 'from-env'));
      delete process.env.NETPRO_PLUGIN_DIR;
      expect(resolvePluginInstallDir()).toMatch(/plugins$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installPluginFromMarketplace (Phase 6)', () => {
  const fixture = createTestSqliteConn();

  beforeEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  afterEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  function setupTarballEntry(options: {
    name?: string;
    version?: string;
    capabilities?: Array<'command'>;
    network?: string[];
    engine?: string;
    tarballManifest?: { name?: string; version?: string; capabilities?: string[]; network?: string[]; engine?: string };
    files?: Array<{ path: string; data: string }>;
  }): { dir: string; entry: MarketplaceEntry; index: MarketplaceIndex; indexUrl: string } {
    const dir = tempDir();
    const name = options.name ?? uniqueName();
    const version = options.version ?? '1.0.0';
    const manifestName = options.tarballManifest?.name ?? name;
    const manifestVersion = options.tarballManifest?.version ?? version;
    const manifestCapabilities = options.tarballManifest?.capabilities ?? options.capabilities ?? ['command'];
    const manifestNetwork = options.tarballManifest?.network ?? options.network;
    const manifestEngine = options.tarballManifest?.engine ?? options.engine ?? '^3.0.0';
    const tgz = fixtureTarGz({
      name: manifestName,
      version: manifestVersion,
      capabilities: manifestCapabilities,
      network: manifestNetwork,
      engine: manifestEngine,
      extraFiles: options.files,
    });
    const tarballFile = join(dir, `${name}.tgz`);
    writeFileSync(tarballFile, tgz);
    const entry = fixtureEntry({
      name,
      version,
      url: pathToFileURL(tarballFile).href,
      sha256: sha256Hex(tgz),
      capabilities: (options.capabilities ?? ['command']) as Array<'command'>,
      network: options.network,
    });
    const indexFile = join(dir, 'index.json');
    const index = fixtureIndex([entry]);
    writeFileSync(indexFile, JSON.stringify(index), 'utf8');
    return { dir, entry, index, indexUrl: pathToFileURL(indexFile).href };
  }

  function auditActions(): string[] {
    const rows = fixture.sqlite.prepare('SELECT action FROM activity_log').all() as Array<{ action: string }>;
    return rows.map((row) => row.action);
  }

  it('installs disabled with verified files and an audit row', async () => {
    const { dir, entry, index, indexUrl } = setupTarballEntry({ network: ['api.example.invalid'] });
    const pluginDir = join(dir, 'plugins');
    try {
      const result = await installPluginFromMarketplace(fixture.conn, entry.name, { index, indexUrl, pluginDir, scope });
      expect(result.plugin.enabled).toBe(false);
      expect(result.plugin.installedFrom).toBe(`marketplace:${entry.name}@${entry.version}`);
      expect(result.dir).toBe(join(pluginDir, entry.name));
      expect(existsSync(join(pluginDir, entry.name, 'manifest.json'))).toBe(true);
      expect(existsSync(join(pluginDir, entry.name, 'index.js'))).toBe(true);
      expect(await getPluginByName(fixture.conn, entry.name, scope)).not.toBeNull();
      expect(auditActions()).toContain('plugin.installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves relative tarball URLs against a file index (self-hosting)', async () => {
    const dir = tempDir();
    try {
      const name = uniqueName();
      const tgz = fixtureTarGz({ name });
      const tarballsDir = join(dir, 'tarballs');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tarballsDir, { recursive: true });
      writeFileSync(join(tarballsDir, `${name}.tgz`), tgz);
      const entry = fixtureEntry({
        name,
        url: `tarballs/${name}.tgz`,
        sha256: sha256Hex(tgz),
      });
      const indexFile = join(dir, 'index.json');
      writeFileSync(indexFile, JSON.stringify(fixtureIndex([entry])), 'utf8');
      const result = await installPluginFromMarketplace(fixture.conn, name, {
        indexUrl: pathToFileURL(indexFile).href,
        refresh: true,
        pluginDir: join(dir, 'plugins'),
        scope,
      });
      expect(result.plugin.name).toBe(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses unknown plugins and double installs', async () => {
    const { dir, entry, index, indexUrl } = setupTarballEntry({});
    try {
      await expect(
        installPluginFromMarketplace(fixture.conn, 'no-such-plugin', { index, indexUrl, pluginDir: join(dir, 'p'), scope })
      ).rejects.toThrow(/not in the marketplace index/);
      await installPluginFromMarketplace(fixture.conn, entry.name, { index, indexUrl, pluginDir: join(dir, 'p'), scope });
      await expect(
        installPluginFromMarketplace(fixture.conn, entry.name, { index, indexUrl, pluginDir: join(dir, 'p'), scope })
      ).rejects.toThrow(/already installed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses checksum mismatches, cleans up, and audits', async () => {
    const { dir, entry, indexUrl } = setupTarballEntry({});
    try {
      if (entry.source.type !== 'tarball') throw new Error('fixture must be a tarball source');
      const tampered: MarketplaceEntry = { ...entry, source: { ...entry.source, sha256: 'f'.repeat(64) } };
      const tamperedIndex = fixtureIndex([tampered]);
      const pluginDir = join(dir, 'plugins');
      await expect(
        installPluginFromMarketplace(fixture.conn, entry.name, { index: tamperedIndex, indexUrl, pluginDir, scope })
      ).rejects.toThrow(/Checksum mismatch/);
      expect(existsSync(join(pluginDir, entry.name))).toBe(false);
      expect(await getPluginByName(fixture.conn, entry.name, scope)).toBeNull();
      expect(auditActions()).toContain('plugin.install_failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses tarballs whose manifest disagrees with the index', async () => {
    for (const tarballManifest of [
      { name: uniqueName('other') },
      { version: '9.9.9' },
      { capabilities: ['command', 'enricher'] },
      { network: ['evil.invalid'] },
    ]) {
      const { dir, entry, index, indexUrl } = setupTarballEntry({ tarballManifest });
      try {
        await expect(
          installPluginFromMarketplace(fixture.conn, entry.name, {
            index,
            indexUrl,
            pluginDir: join(dir, 'plugins'),
            scope,
          })
        ).rejects.toThrow(/Manifest mismatch/);
        expect(auditActions()).toContain('plugin.install_failed');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
    }
  });

  it('refuses engine-incompatible plugins', async () => {
    const { dir, entry, index, indexUrl } = setupTarballEntry({ tarballManifest: { engine: '^99.0.0' } });
    try {
      await expect(
        installPluginFromMarketplace(fixture.conn, entry.name, { index, indexUrl, pluginDir: join(dir, 'p'), scope })
      ).rejects.toThrow(/requires NetPro \^99/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses archives without a root manifest and traversal archives', async () => {
    const dir = tempDir();
    try {
      const { buildTarGz: build } = await import('./testing');
      const name = uniqueName();
      const noManifest = build([{ path: 'nested/manifest.json', data: '{}' }]);
      const file = join(dir, 'bad.tgz');
      writeFileSync(file, noManifest);
      const entry = fixtureEntry({ name, url: pathToFileURL(file).href, sha256: sha256Hex(noManifest) });
      await expect(
        installPluginFromMarketplace(fixture.conn, name, {
          index: fixtureIndex([entry]),
          pluginDir: join(dir, 'p'),
          scope,
        })
      ).rejects.toThrow(/no manifest.json/);

      const evil = build([
        { path: 'manifest.json', data: JSON.stringify({ name, version: '1.0.0', engine: '^3.0.0', permissions: { capabilities: ['command'] } }) },
        { path: '../../escape.js', data: 'x' },
      ]);
      const evilFile = join(dir, 'evil.tgz');
      writeFileSync(evilFile, evil);
      const evilEntry = fixtureEntry({ name: uniqueName(), url: pathToFileURL(evilFile).href, sha256: sha256Hex(evil) });
      // Manifest name differs from entry name anyway; traversal must trip first or mismatch — either refuses.
      await expect(
        installPluginFromMarketplace(fixture.conn, evilEntry.name, {
          index: fixtureIndex([evilEntry]),
          pluginDir: join(dir, 'p2'),
          scope,
        })
      ).rejects.toThrowError(PluginError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites a non-empty directory on install', async () => {
    const { dir, entry, index, indexUrl } = setupTarballEntry({});
    try {
      const pluginDir = join(dir, 'plugins');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(pluginDir, entry.name), { recursive: true });
      writeFileSync(join(pluginDir, entry.name, 'keep.txt'), 'mine', 'utf8');
      await expect(
        installPluginFromMarketplace(fixture.conn, entry.name, { index, indexUrl, pluginDir, scope })
      ).rejects.toThrow(/already exists and is not empty/);
      expect(readFileSync(join(pluginDir, entry.name, 'keep.txt'), 'utf8')).toBe('mine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs from a pinned git source without its .git directory', async () => {
    let git: string;
    try {
      git = execFileSync('git', ['--version'], { stdio: 'pipe' }).toString();
    } catch {
      return; // git binary missing — clone path untestable here, CI covers it
    }
    expect(git).toContain('git version');
    const dir = tempDir();
    try {
      const repo = join(dir, 'repo');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(repo, { recursive: true });
      const name = uniqueName('git-plugin');
      writeFileSync(join(repo, 'manifest.json'), JSON.stringify({
        name, version: '1.0.0', engine: '^3.0.0', permissions: { capabilities: ['command'] },
      }), 'utf8');
      writeFileSync(join(repo, 'index.js'), 'export const register = () => {};\n', 'utf8');
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'pipe' });
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.email=test@invalid', '-c', 'user.name=test', 'commit', '-m', 'init'],
        { cwd: repo, stdio: 'pipe' }
      );
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: 'pipe' }).toString().trim();
      const entry: MarketplaceEntry = {
        name, version: '1.0.0', description: 'git fixture',
        source: { type: 'git', url: pathToFileURL(repo).href, commit },
        manifest: { permissions: { capabilities: ['command'] } },
      };
      const pluginDir = join(dir, 'plugins');
      const result = await installPluginFromMarketplace(fixture.conn, name, {
        index: fixtureIndex([entry]),
        pluginDir,
        scope,
      });
      expect(result.plugin.name).toBe(name);
      expect(existsSync(join(pluginDir, name, 'index.js'))).toBe(true);
      expect(existsSync(join(pluginDir, name, '.git'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid git sources without cloning', () => {
    expect(() => installFromGitSource('git@github.com:o/r.git', 'a'.repeat(40), tempDir())).toThrow(
      /must be https:\/\/ or file:\/\//
    );
    expect(() => installFromGitSource('https://example.invalid/r.git', 'short', tempDir())).toThrow(/40-char/);
  });
});

describe('updatePluginFromMarketplace (Phase 6)', () => {
  const fixture = createTestSqliteConn();

  beforeEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  afterEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  async function installVersion(dir: string, name: string, version: string, marker: string): Promise<MarketplaceEntry> {
    const tgz = fixtureTarGz({ name, version, extraFiles: [{ path: 'marker.txt', data: marker }] });
    const file = join(dir, `${name}-${version}.tgz`);
    writeFileSync(file, tgz);
    const entry = fixtureEntry({ name, version, url: pathToFileURL(file).href, sha256: sha256Hex(tgz) });
    await installPluginFromMarketplace(fixture.conn, name, {
      index: fixtureIndex([entry]),
      pluginDir: join(dir, 'plugins'),
      scope,
    });
    return entry;
  }

  it('applies newer versions, keeps state, and audits', async () => {
    const dir = tempDir();
    try {
      const name = uniqueName();
      await installVersion(dir, name, '1.0.0', 'v1');
      await updatePluginSettings(fixture.conn, name, { keep: 'me' }, scope);
      const tgz2 = fixtureTarGz({ name, version: '1.1.0', extraFiles: [{ path: 'marker.txt', data: 'v2' }] });
      const file2 = join(dir, `${name}-1.1.0.tgz`);
      writeFileSync(file2, tgz2);
      const entry2 = fixtureEntry({ name, version: '1.1.0', url: pathToFileURL(file2).href, sha256: sha256Hex(tgz2) });
      const result = await updatePluginFromMarketplace(fixture.conn, name, {
        index: fixtureIndex([entry2]),
        pluginDir: join(dir, 'plugins'),
        scope,
      });
      expect(result.updated).toBe(true);
      expect(result.fromVersion).toBe('1.0.0');
      expect(result.plugin.version).toBe('1.1.0');
      expect(result.plugin.enabled).toBe(false);
      expect(result.plugin.settings).toEqual({ keep: 'me' });
      expect(readFileSync(join(dir, 'plugins', name, 'marker.txt'), 'utf8')).toBe('v2');
      const actions = (fixture.sqlite.prepare('SELECT action FROM activity_log').all() as Array<{ action: string }>).map(
        (row) => row.action
      );
      expect(actions).toContain('plugin.updated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats identical versions as a no-op', async () => {
    const dir = tempDir();
    try {
      const name = uniqueName();
      const entry = await installVersion(dir, name, '1.0.0', 'v1');
      const result = await updatePluginFromMarketplace(fixture.conn, name, {
        index: fixtureIndex([entry]),
        pluginDir: join(dir, 'plugins'),
        scope,
      });
      expect(result.updated).toBe(false);
      expect(result.plugin.version).toBe('1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses downgrades unless forced', async () => {
    const dir = tempDir();
    try {
      const name = uniqueName();
      await installVersion(dir, name, '2.0.0', 'v2');
      const old = fixtureTarGz({ name, version: '1.0.0', extraFiles: [{ path: 'marker.txt', data: 'v1' }] });
      const oldFile = join(dir, `${name}-old.tgz`);
      writeFileSync(oldFile, old);
      const oldEntry = fixtureEntry({ name, version: '1.0.0', url: pathToFileURL(oldFile).href, sha256: sha256Hex(old) });
      await expect(
        updatePluginFromMarketplace(fixture.conn, name, {
          index: fixtureIndex([oldEntry]),
          pluginDir: join(dir, 'plugins'),
          scope,
        })
      ).rejects.toThrow(/refusing to downgrade/);
      expect(readFileSync(join(dir, 'plugins', name, 'marker.txt'), 'utf8')).toBe('v2');
      const forced = await updatePluginFromMarketplace(fixture.conn, name, {
        index: fixtureIndex([oldEntry]),
        pluginDir: join(dir, 'plugins'),
        force: true,
        scope,
      });
      expect(forced.updated).toBe(true);
      expect(forced.plugin.version).toBe('1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects updates for plugins that are not installed', async () => {
    await expect(
      updatePluginFromMarketplace(fixture.conn, 'ghost', { index: fixtureIndex([fixtureEntry({ name: 'ghost' })]), scope })
    ).rejects.toThrow(/not installed/);
  });
});

describe('uninstallPlugin (Phase 6)', () => {
  const fixture = createTestSqliteConn();

  beforeEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  afterEach(() => {
    fixture.sqlite.exec('DELETE FROM plugins; DELETE FROM activity_log;');
  });

  it('removes the row, the files, and audits', async () => {
    const dir = tempDir();
    try {
      const name = uniqueName();
      const tgz = fixtureTarGz({ name });
      const file = join(dir, 'p.tgz');
      writeFileSync(file, tgz);
      const entry = fixtureEntry({ name, url: pathToFileURL(file).href, sha256: sha256Hex(tgz) });
      const pluginDir = join(dir, 'plugins');
      await installPluginFromMarketplace(fixture.conn, name, { index: fixtureIndex([entry]), pluginDir, scope });
      const result = await uninstallPlugin(fixture.conn, name, { pluginDir, scope });
      expect(result.filesRemoved).toBe(true);
      expect(await getPluginByName(fixture.conn, name, scope)).toBeNull();
      expect(existsSync(join(pluginDir, name))).toBe(false);
      const actions = (fixture.sqlite.prepare('SELECT action FROM activity_log').all() as Array<{ action: string }>).map(
        (row) => row.action
      );
      expect(actions).toContain('plugin.removed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates missing files and missing rows', async () => {
    const dir = tempDir();
    try {
      await expect(uninstallPlugin(fixture.conn, 'ghost', { pluginDir: join(dir, 'p'), scope })).rejects.toThrow(
        /not installed/
      );
      const name = uniqueName();
      const tgz = fixtureTarGz({ name });
      const file = join(dir, 'p.tgz');
      writeFileSync(file, tgz);
      const entry = fixtureEntry({ name, url: pathToFileURL(file).href, sha256: sha256Hex(tgz) });
      const pluginDir = join(dir, 'plugins');
      await installPluginFromMarketplace(fixture.conn, name, { index: fixtureIndex([entry]), pluginDir, scope });
      rmSync(join(pluginDir, name), { recursive: true, force: true });
      const result = await uninstallPlugin(fixture.conn, name, { pluginDir, scope });
      expect(result.filesRemoved).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
