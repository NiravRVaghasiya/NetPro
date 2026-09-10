// Test-only helpers for the plugin marketplace: do not import from runtime
// code. Builds minimal USTAR tar.gz buffers (including malformed ones for
// adversarial tests) and marketplace index fixtures.
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { MarketplaceEntry, MarketplaceIndex } from './marketplace';

export interface TestTarEntry {
  path: string;
  data?: string | Buffer;
  typeflag?: string;
  mode?: number;
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  bytes.copy(header, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0') + '\0';
  Buffer.from(text, 'ascii').copy(header, offset);
}

/** Build one 512-byte USTAR header with a valid checksum. */
export function buildTarHeader(entry: TestTarEntry, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  // Checksum field: eight spaces for the computation, then the value.
  header.fill(0x20, 148, 156);
  header[156] = (entry.typeflag ?? '0').charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  writeOctal(header, 148, 8, sum);
  // GNU tar terminates the checksum with NUL + space; plain NUL parses too.
  return header;
}

/** Assemble entries into a tar buffer (with end-of-archive zero blocks). */
export function buildTar(entries: TestTarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    parts.push(buildTarHeader(entry, data.length));
    if (data.length > 0) {
      parts.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding > 0) parts.push(Buffer.alloc(padding, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0)); // two zero blocks
  return Buffer.concat(parts);
}

export function buildTarGz(entries: TestTarEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A minimal valid plugin manifest JSON for fixture tarballs. */
export function fixtureManifestText(options: {
  name?: string;
  version?: string;
  engine?: string;
  capabilities?: string[];
  network?: string[];
}): string {
  return JSON.stringify({
    name: options.name ?? 'fixture-plugin',
    version: options.version ?? '1.0.0',
    engine: options.engine ?? '^3.0.0',
    description: 'Fixture plugin for marketplace tests.',
    permissions: {
      capabilities: options.capabilities ?? ['command'],
      network: options.network,
    },
  });
}

export function fixtureTarGz(options: {
  name?: string;
  version?: string;
  engine?: string;
  capabilities?: string[];
  network?: string[];
  extraFiles?: TestTarEntry[];
}): Buffer {
  return buildTarGz([
    { path: 'manifest.json', data: fixtureManifestText(options) },
    { path: 'index.js', data: 'export const register = () => {};\n' },
    ...(options.extraFiles ?? []),
  ]);
}

/** A minimal valid marketplace index object for fixtures. */
export function fixtureIndex(entries: MarketplaceEntry[]): MarketplaceIndex {
  return { schema: 1, updated_at: new Date().toISOString(), plugins: entries };
}

export function fixtureEntry(options: {
  name?: string;
  version?: string;
  description?: string;
  url?: string;
  sha256?: string;
  capabilities?: Array<'source' | 'enricher' | 'ai-provider' | 'content-provider' | 'event-discovery' | 'command'>;
  network?: string[];
}): MarketplaceEntry {
  return {
    name: options.name ?? 'fixture-plugin',
    version: options.version ?? '1.0.0',
    description: options.description ?? 'Fixture plugin for marketplace tests.',
    source: { type: 'tarball', url: options.url ?? 'https://example.invalid/fixture.tgz', sha256: options.sha256 ?? '0'.repeat(64) },
    manifest: {
      permissions: {
        capabilities: options.capabilities ?? ['command'],
        network: options.network,
      },
    },
  };
}
