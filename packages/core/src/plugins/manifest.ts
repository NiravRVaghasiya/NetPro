// packages/core/src/plugins/manifest.ts
// Manifest validation + engine range check.

import type { PluginManifest, SettingSpec, PluginCapability } from './types';
import { PLUGIN_CAPABILITIES, MAX_SETTINGS, MAX_MANIFEST_SIZE } from './types';

export class PluginError extends Error {
  readonly code: 'invalid_manifest' | 'engine_mismatch' | 'not_found' | 'conflict' | 'forbidden';
  constructor(code: PluginError['code'], message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SETTING_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateManifest(input: unknown): PluginManifest {
  if (!isPlainObject(input)) {
    throw new PluginError('invalid_manifest', 'Manifest must be an object.');
  }
  const raw = input as Record<string, unknown>;

  // size guard
  const json = JSON.stringify(raw);
  if (json.length > MAX_MANIFEST_SIZE) {
    throw new PluginError('invalid_manifest', `Manifest too large (>${MAX_MANIFEST_SIZE} bytes).`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new PluginError('invalid_manifest', 'Invalid plugin name — must match npm-style id (lowercase, alphanumeric, . _ -).');
  }
  if (name.startsWith('.') || name.startsWith('_')) {
    throw new PluginError('invalid_manifest', 'Plugin name cannot start with . or _.');
  }

  const version = raw.version;
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new PluginError('invalid_manifest', 'Invalid version — must be semver x.y.z.');
  }

  const engine = raw.engine;
  if (typeof engine !== 'string' || !engine.trim()) {
    throw new PluginError('invalid_manifest', 'Engine range required (e.g. ^3.0.0).');
  }
  if (!isValidEngineRange(engine)) {
    throw new PluginError('invalid_manifest', `Invalid engine range: ${engine}`);
  }

  const permissions = raw.permissions;
  if (!isPlainObject(permissions)) {
    throw new PluginError('invalid_manifest', 'permissions object required.');
  }
  const caps = (permissions as Record<string, unknown>).capabilities;
  if (!Array.isArray(caps) || caps.length === 0) {
    throw new PluginError('invalid_manifest', 'permissions.capabilities must be a non-empty array.');
  }
  for (const c of caps) {
    if (typeof c !== 'string' || !(PLUGIN_CAPABILITIES as string[]).includes(c)) {
      throw new PluginError('invalid_manifest', `Unknown capability: ${String(c)}`);
    }
  }

  const network = (permissions as Record<string, unknown>).network;
  if (network !== undefined) {
    if (!Array.isArray(network)) {
      throw new PluginError('invalid_manifest', 'permissions.network must be an array of hosts.');
    }
    if (network.length > 100) {
      throw new PluginError('invalid_manifest', 'permissions.network too large (max 100 hosts).');
    }
    for (const h of network) {
      if (typeof h !== 'string' || h.length > 253) {
        throw new PluginError('invalid_manifest', `Invalid network host: ${String(h)}`);
      }
      // Disallow accidental subdomain matching — require explicit wildcard prefix
      if (h.includes('*')) {
        if (!h.startsWith('*.')) {
          throw new PluginError('invalid_manifest', `Wildcard must be prefix *. : ${h}`);
        }
        const rest = h.slice(2);
        if (!HOST_RE.test(rest)) {
          throw new PluginError('invalid_manifest', `Invalid network host: ${String(h)}`);
        }
      } else {
        if (!HOST_RE.test(h)) {
          throw new PluginError('invalid_manifest', `Invalid network host: ${String(h)}`);
        }
      }
    }
  }

  const settings = raw.settings;
  if (settings !== undefined) {
    if (!Array.isArray(settings)) {
      throw new PluginError('invalid_manifest', 'settings must be an array.');
    }
    if (settings.length > MAX_SETTINGS) {
      throw new PluginError('invalid_manifest', `Too many settings (max ${MAX_SETTINGS}).`);
    }
    const seen = new Set<string>();
    for (const s of settings) {
      if (!isPlainObject(s)) {
        throw new PluginError('invalid_manifest', 'Each setting must be an object.');
      }
      const key = (s as Record<string, unknown>).key;
      const label = (s as Record<string, unknown>).label;
      const type = (s as Record<string, unknown>).type;
      if (typeof key !== 'string' || !SETTING_KEY_RE.test(key)) {
        throw new PluginError('invalid_manifest', `Invalid setting key: ${String(key)}`);
      }
      if (seen.has(key)) {
        throw new PluginError('invalid_manifest', `Duplicate setting key: ${key}`);
      }
      seen.add(key);
      if (typeof label !== 'string' || !label.trim()) {
        throw new PluginError('invalid_manifest', `Setting ${key} requires a label.`);
      }
      if (!['string', 'number', 'boolean', 'secret'].includes(type as string)) {
        throw new PluginError('invalid_manifest', `Setting ${key} has invalid type: ${String(type)}`);
      }
      if ((s as Record<string, unknown>).description !== undefined && typeof (s as Record<string, unknown>).description !== 'string') {
        throw new PluginError('invalid_manifest', `Setting ${key} description must be string.`);
      }
    }
  }

  // optional fields
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new PluginError('invalid_manifest', 'description must be string.');
  }
  if (raw.homepage !== undefined && typeof raw.homepage !== 'string') {
    throw new PluginError('invalid_manifest', 'homepage must be string.');
  }
  if (raw.entry !== undefined && typeof raw.entry !== 'string') {
    throw new PluginError('invalid_manifest', 'entry must be string.');
  }
  if (raw.entry && (raw.entry.includes('..') || raw.entry.startsWith('/') || raw.entry.startsWith('\\'))) {
    throw new PluginError('invalid_manifest', 'entry must be a relative path without ..');
  }

  return {
    name: name as string,
    version: version as string,
    engine: (engine as string).trim(),
    description: raw.description as string | undefined,
    homepage: raw.homepage as string | undefined,
    entry: (raw.entry as string | undefined) ?? 'index.js',
    permissions: {
      network: network as string[] | undefined,
      capabilities: caps as PluginCapability[],
    },
    settings: settings as SettingSpec[] | undefined,
  };
}

function isValidEngineRange(range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;
  // Very permissive: allow ^ ~ >= > = exact, and combinations with spaces
  // e.g. "^3.0.0", "~3.0.0", ">=3.0.0 <4.0.0", "3.0.0", "^3.0.0 || ^4.0.0"
  // We validate by tokenizing and checking each comparator has semver.
  const parts = trimmed.split(/\s*\|\|\s*|\s+/).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(?:\^|~|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
    if (!m) {
      // allow e.g. ">=3.0.0" already matched, but also check for bare range like ">=3.0.0"
      // The regex above should match; if not, fail
      return false;
    }
    if (!SEMVER_RE.test(m[1]!)) return false;
  }
  return true;
}

// Minimal semver range check — supports ^, ~, >=, >, =, exact
export function satisfiesEngineRange(version: string, range: string): boolean {
  if (!SEMVER_RE.test(version)) return false;
  const ver = parseSemver(version);
  if (!ver) return false;

  // Split OR groups
  const orGroups = range.split(/\s*\|\|\s*/);
  for (const group of orGroups) {
    const andParts = group.trim().split(/\s+/).filter(Boolean);
    let ok = true;
    for (const part of andParts) {
      if (!satisfiesSingle(ver, part)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(v: string): SemVer | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // prerelease: no prerelease > prerelease
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return 0;
}

function satisfiesSingle(ver: SemVer, rangePart: string): boolean {
  const m = rangePart.match(/^(?:(\^|~|>=|<=|>|<|=)?\s*)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (!m) return false;
  const op = m[1] ?? '';
  const rangeVerStr = m[2]!;
  const rangeVer = parseSemver(rangeVerStr);
  if (!rangeVer) return false;

  const cmp = compare(ver, rangeVer);

  switch (op) {
    case '':
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^': {
      // ^3.0.0 => >=3.0.0 <4.0.0, ^0.2.3 => >=0.2.3 <0.3.0, ^0.0.3 => >=0.0.3 <0.0.4
      if (cmp < 0) return false;
      if (rangeVer.major > 0) {
        return ver.major === rangeVer.major;
      }
      if (rangeVer.minor > 0) {
        return ver.major === 0 && ver.minor === rangeVer.minor;
      }
      return ver.major === 0 && ver.minor === 0 && ver.patch === rangeVer.patch;
    }
    case '~': {
      // ~3.0.0 => >=3.0.0 <3.1.0, ~3.0 => same
      if (cmp < 0) return false;
      return ver.major === rangeVer.major && ver.minor === rangeVer.minor;
    }
    default:
      return false;
  }
}

export function definePlugin(manifest: PluginManifest, register: (api: import('./types').PluginApi) => void | Promise<void>) {
  const validated = validateManifest(manifest);
  if (typeof register !== 'function') {
    throw new PluginError('invalid_manifest', 'register must be a function.');
  }
  return {
    manifest: validated,
    register,
  };
}
