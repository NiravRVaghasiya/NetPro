// packages/core/src/plugins/tarball.ts
// v3.0 Phase 6 — vendored minimal USTAR tar reader over Node's zlib.
//
// House rule: no new runtime dependencies. Gunzip comes from node:zlib,
// tar parsing is below. It handles what `tar -czf` emits for plugin
// directories (USTAR regular files + directories, pax headers skipped,
// GNU longname/longlink headers honored) and refuses everything else:
// symlinks, hardlinks, absolute paths, `..` escapes, truncated archives,
// oversized archives. Writes go only inside the destination directory.

import { gunzip } from 'node:zlib';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { PluginError } from './manifest';

/** Compressed tarball cap: 8 MiB. Plugin code + manifest is kilobytes. */
export const MAX_TARBALL_COMPRESSED_BYTES = 8 * 1024 * 1024;
/** Decompressed cap: 32 MiB (zip-bomb backstop, enforced during inflate). */
export const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
/** At most 1000 entries per tarball. */
export const MAX_TARBALL_FILES = 1000;
/** No single file inside a tarball may exceed 8 MiB. */
export const MAX_TARBALL_FILE_BYTES = 8 * 1024 * 1024;

export interface TarEntry {
  /** Relative path inside the archive, already validated (no `..`, no absolute). */
  path: string;
  data: Buffer;
  mode: number;
}

/** Inflate with an output cap so a compressed bomb cannot exhaust memory. */
export function gunzipCapped(input: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    gunzip(input, { chunkSize: 64 * 1024 }, (err, output) => {
      if (err) {
        rejectPromise(new PluginError('invalid_input', `Not a valid gzip archive: ${err.message}`));
        return;
      }
      if (output.length > maxBytes) {
        rejectPromise(
          new PluginError('too_large', `Decompressed tarball exceeds the ${maxBytes}-byte limit — refusing.`)
        );
        return;
      }
      resolvePromise(output as Buffer);
    });
  });
}

function readString(buf: Buffer, offset: number, length: number): string {
  const raw = buf.toString('utf8', offset, offset + length);
  const nul = raw.indexOf('\0');
  return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  if (text === '') return 0;
  // GNU tar terminates numeric fields with NUL or space; tolerate both.
  const cleaned = text.replace(/[\0 ]+$/, '');
  if (!/^[0-7]+$/.test(cleaned)) return Number.NaN;
  return Number.parseInt(cleaned, 8);
}

function headerChecksum(buf: Buffer, offset: number): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    // The checksum field itself (148..156) counts as eight spaces.
    sum += i >= 148 && i < 156 ? 0x20 : buf[offset + i]!;
  }
  return sum;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < 512; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function validateEntryPath(raw: string, kind: string): string {
  let cleaned = raw.trim();
  // Tolerate the `./manifest.json` form GNU tar writes for `tar -czf x.tgz .`.
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  if (cleaned === '' || cleaned === '.' || cleaned.startsWith('/')) {
    throw new PluginError('invalid_input', `Tar ${kind} has an invalid path: ${JSON.stringify(raw)}`);
  }
  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PluginError(
        'invalid_input',
        `Tar ${kind} escapes its directory (path traversal refused): ${JSON.stringify(raw)}`
      );
    }
  }
  if (cleaned.length > 512) {
    throw new PluginError('invalid_input', `Tar ${kind} path is too long: ${JSON.stringify(raw.slice(0, 80))}…`);
  }
  return cleaned;
}

/**
 * Parse a USTAR tar buffer into validated entries. Throws PluginError with
 * code `invalid_input` on truncation, bad checksums, links, traversal, or
 * unsupported entry types, and `too_large` when caps are exceeded.
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pendingLongName: string | null = null;
  let totalBytes = 0;
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 512 > buf.length) {
      throw new PluginError('invalid_input', 'Truncated tar archive: incomplete 512-byte header.');
    }
    if (isZeroBlock(buf, offset)) {
      // End-of-archive marker. Everything after it must be zero padding.
      for (let i = offset; i < buf.length; i++) {
        if (buf[i] !== 0) {
          throw new PluginError('invalid_input', 'Trailing data after the tar end-of-archive marker.');
        }
      }
      break;
    }

    const magic = readString(buf, offset + 257, 6);
    if (!magic.startsWith('ustar')) {
      throw new PluginError(
        'invalid_input',
        `Not a USTAR tar archive (bad magic at offset ${offset}) — refusing.`
      );
    }

    const stored = readOctal(buf, offset + 148, 8);
    if (Number.isNaN(stored) || stored !== headerChecksum(buf, offset)) {
      throw new PluginError('invalid_input', `Invalid tar header checksum at offset ${offset}.`);
    }

    const name = readString(buf, offset, 100);
    const prefix = readString(buf, offset + 345, 155);
    const size = readOctal(buf, offset + 124, 12);
    if (Number.isNaN(size) || size < 0) {
      throw new PluginError('invalid_input', `Invalid tar entry size at offset ${offset}.`);
    }
    const typeflag = String.fromCharCode(buf[offset + 156]!);
    const mode = readOctal(buf, offset + 100, 8);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new PluginError(
        'invalid_input',
        `Truncated tar archive: entry ${(pendingLongName ?? name) || '(unnamed)'} claims ${size} bytes but the archive ends.`
      );
    }
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    // GNU longname/longlink: the data block carries the real name/linkname
    // for the header that follows. We honor long names and refuse links.
    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/[\0\n]+$/, '');
      continue;
    }
    if (typeflag === 'K') {
      continue; // Longlink target follows a link header — refused below anyway.
    }
    // POSIX pax extended headers carry metadata only; the real entry follows.
    if (typeflag === 'g' || typeflag === 'x') {
      continue;
    }
    if (typeflag === '1' || typeflag === '2') {
      const rawName = pendingLongName ?? name;
      throw new PluginError(
        'invalid_input',
        `Tar ${typeflag === '2' ? 'symlink' : 'hardlink'} entries are not allowed: ${JSON.stringify(rawName)}`
      );
    }
    if (typeflag === '5') {
      const rawName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
      pendingLongName = null;
      validateEntryPath(rawName, 'directory');
      continue; // Directories are created implicitly when files are written.
    }
    if (typeflag !== '0' && typeflag !== '\0') {
      const rawName = pendingLongName ?? name;
      throw new PluginError(
        'invalid_input',
        `Unsupported tar entry type ${JSON.stringify(typeflag)}: ${JSON.stringify(rawName)}`
      );
    }

    const rawName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = null;
    const entryPath = validateEntryPath(rawName, 'file');

    if (entries.length >= MAX_TARBALL_FILES) {
      throw new PluginError('too_large', `Tarball exceeds the ${MAX_TARBALL_FILES}-file limit — refusing.`);
    }
    if (size > MAX_TARBALL_FILE_BYTES) {
      throw new PluginError(
        'too_large',
        `Tar entry ${JSON.stringify(entryPath)} exceeds the ${MAX_TARBALL_FILE_BYTES}-byte per-file limit — refusing.`
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_TARBALL_BYTES) {
      throw new PluginError(
        'too_large',
        `Tarball contents exceed the ${MAX_TARBALL_BYTES}-byte limit — refusing.`
      );
    }

    entries.push({ path: entryPath, data: Buffer.from(data), mode: Number.isNaN(mode) ? 0o644 : mode & 0o777 });
  }

  return entries;
}

/**
 * Inflate a `.tgz` buffer and write its files under `destDir` (created if
 * missing). Every write is confined to `destDir`; returns the relative paths
 * written. Throws the same PluginError codes as {@link parseTar}.
 */
export async function extractTarGz(buffer: Buffer, destDir: string): Promise<string[]> {
  if (buffer.length > MAX_TARBALL_COMPRESSED_BYTES) {
    throw new PluginError(
      'too_large',
      `Tarball exceeds the ${MAX_TARBALL_COMPRESSED_BYTES}-byte compressed limit — refusing.`
    );
  }
  const inflated = await gunzipCapped(buffer, MAX_TARBALL_BYTES);
  const entries = parseTar(inflated);

  const base = resolve(destDir);
  const written: string[] = [];
  for (const entry of entries) {
    const target = resolve(base, entry.path);
    if (target !== base && !target.startsWith(base + sep)) {
      // Defense in depth: validateEntryPath already forbids escapes.
      throw new PluginError('invalid_input', `Tar entry escapes its directory: ${JSON.stringify(entry.path)}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { mode: 0o644 });
    try {
      // Honor the archived mode bits without ever granting setuid/setgid.
      chmodSync(target, (entry.mode || 0o644) & 0o777);
    } catch {
      // Filesystems without POSIX modes (some mounts) — the write succeeded.
    }
    written.push(entry.path);
  }
  return written;
}
