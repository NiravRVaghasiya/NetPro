// packages/core/src/plugins/tarball.test.ts
// v3.0 Phase 6 — vendored USTAR reader: round-trips, GNUisms, adversarial
// archives, caps, and compatibility with the shipped marketplace tarball.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  parseTar,
  extractTarGz,
  gunzipCapped,
  MAX_TARBALL_FILE_BYTES,
  MAX_TARBALL_BYTES,
} from './tarball';
import { PluginError } from './manifest';
import { buildTarGz, buildTar, fixtureManifestText } from './testing';

const testRoot = fileURLToPath(new URL('.', import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'netpro-tarball-test-'));
}

describe('tarball round-trip (Phase 6)', () => {
  it('extracts a minimal plugin tarball', async () => {
    const dir = tempDir();
    try {
      const tgz = buildTarGz([
        { path: 'manifest.json', data: fixtureManifestText({}) },
        { path: 'index.js', data: 'export const register = () => {};\n' },
        { path: 'lib/helper.js', data: 'export const x = 1;\n' },
      ]);
      const written = await extractTarGz(tgz, dir);
      expect(written.sort()).toEqual(['index.js', 'lib/helper.js', 'manifest.json']);
      expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toContain('fixture-plugin');
      expect(readFileSync(join(dir, 'lib/helper.js'), 'utf8')).toContain('export const x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates ./ prefixes the way GNU tar writes them', async () => {
    const dir = tempDir();
    try {
      const tgz = buildTarGz([
        { path: './manifest.json', data: fixtureManifestText({}) },
        { path: './index.js', data: 'console.log(1);\n' },
      ]);
      const written = await extractTarGz(tgz, dir);
      expect(written.sort()).toEqual(['index.js', 'manifest.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips pax extended headers and honors GNU long names', () => {
    const longName = `nested/${'a'.repeat(120)}.js`;
    const entries = parseTar(
      gunzipSync(
        buildTarGz([
          { path: 'pax-header', data: '30 mtime=123\n', typeflag: 'x' },
          { path: '././@LongLink', data: `${longName}\n`, typeflag: 'L' },
          { path: 'truncated-name', data: 'long content\n' },
        ])
      )
    );
    expect(entries.map((e) => e.path)).toEqual([longName]);
    expect(entries[0]!.data.toString('utf8')).toBe('long content\n');
  });

  it('extracts the shipped marketplace tarball (GNU tar compatibility)', async () => {
    const shipped = join(
      testRoot,
      '..',
      '..',
      '..',
      '..',
      'marketplace',
      'tarballs',
      'example-event-discovery-1.0.0.tgz'
    );
    expect(existsSync(shipped)).toBe(true);
    const dir = tempDir();
    try {
      const written = await extractTarGz(readFileSync(shipped), dir);
      expect(written).toContain('manifest.json');
      expect(written).toContain('index.js');
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { name: string };
      expect(manifest.name).toBe('example-event-discovery');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tarball adversarial archives (Phase 6)', () => {
  it('refuses path traversal and writes nothing outside the destination', async () => {
    const dir = tempDir();
    const outside = join(dirname(dir), `netpro-tarball-escape-${process.pid}.txt`);
    try {
      const tgz = buildTarGz([
        { path: 'manifest.json', data: fixtureManifestText({}) },
        { path: '../../evil.txt', data: 'escaped\n' },
      ]);
      await expect(extractTarGz(tgz, join(dir, 'plugin'))).rejects.toThrowError(PluginError);
      await expect(extractTarGz(tgz, join(dir, 'plugin'))).rejects.toThrow(/traversal/);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it('refuses absolute paths', () => {
    const tar = gunzipSync(buildTarGz([{ path: '/tmp/evil.js', data: 'x\n' }]));
    expect(() => parseTar(tar)).toThrow(/invalid path/);
  });

  it('refuses symlinks and hardlinks', () => {
    const sym = gunzipSync(buildTarGz([{ path: 'link', data: 'target', typeflag: '2' }]));
    expect(() => parseTar(sym)).toThrow(/symlink/);
    const hard = gunzipSync(buildTarGz([{ path: 'link', data: 'target', typeflag: '1' }]));
    expect(() => parseTar(hard)).toThrow(/hardlink/);
  });

  it('refuses truncated gzip archives', async () => {
    const full = buildTarGz([
      { path: 'manifest.json', data: fixtureManifestText({}) },
      { path: 'index.js', data: 'x'.repeat(2000) },
    ]);
    const cut = full.subarray(0, Math.floor(full.length / 2));
    await expect(extractTarGz(cut, tempDir())).rejects.toThrowError(PluginError);
  });

  it('refuses truncated tar data inside a valid gzip', () => {
    const tar = buildTar([{ path: 'index.js', data: 'x'.repeat(100) }]);
    const cut = tar.subarray(0, tar.length - 600); // chop mid-entry
    expect(() => parseTar(cut)).toThrow(/Truncated/);
  });

  it('refuses incomplete headers', () => {
    expect(() => parseTar(Buffer.alloc(100, 0x61))).toThrow(/incomplete 512-byte header/);
  });

  it('refuses non-gzip input', async () => {
    await expect(extractTarGz(Buffer.from('not a gzip archive'), tempDir())).rejects.toThrow(/gzip/);
  });

  it('refuses bad header checksums', () => {
    const tar = buildTar([{ path: 'index.js', data: 'x\n' }]);
    tar[10] = (tar[10]! + 1) % 256; // corrupt the name, checksum no longer matches
    expect(() => parseTar(tar)).toThrow(/checksum/);
  });

  it('refuses trailing garbage after the end marker', () => {
    const tar = buildTar([{ path: 'index.js', data: 'x\n' }]);
    const dirty = Buffer.concat([tar, Buffer.from('trailing garbage'.padEnd(512, '\0'))]);
    expect(() => parseTar(dirty)).toThrow(/Trailing data/);
  });

  it('refuses unsupported entry types', () => {
    const tar = buildTar([{ path: 'dev', data: '', typeflag: '3' }]);
    expect(() => parseTar(tar)).toThrow(/Unsupported tar entry/);
  });

  it('enforces the per-file cap', () => {
    const big = buildTar([{ path: 'big.bin', data: Buffer.alloc(MAX_TARBALL_FILE_BYTES + 1, 0x61) }]);
    expect(() => parseTar(big)).toThrow(/per-file limit/);
  });

  it('enforces the decompressed-size cap during inflate', async () => {
    const tgz = gzipSync(Buffer.alloc(MAX_TARBALL_BYTES + 1024, 0x61));
    await expect(gunzipCapped(tgz, MAX_TARBALL_BYTES)).rejects.toThrow(/Decompressed tarball exceeds/);
  });
});
