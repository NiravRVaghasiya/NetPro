// packages/core/src/plugins/marketplace.ts
// v3.0 Phase 6 — self-hosted marketplace: a static plugin index format
// anyone can host, an installer that verifies what it installs, and a
// permissions review in front of every enable.
//
// No central hosting, no accounts, no telemetry: fetching the index is a
// plain GET with a static user agent, and the fetch cache is local. The
// default index is a file in this repo (`marketplace/index.json`),
// overridable via MARKETPLACE_INDEX_URL. Tarballs are checksummed (sha256
// required, mismatch = hard refusal, audited) and their manifests must
// match the index listing exactly, or the install is refused.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, stat, mkdir, rm, readdir, mkdtemp, cp } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { SqliteConn, PgConn } from '@netpro/db';
import type { WorkspaceScope } from '../workspaces/scope';
import { resolveScope } from '../workspaces/scope';
import { writeActivityLog } from '../crm/activity';
import type { PluginCapability, PluginManifest, PluginListItem } from './types';
import { validateManifest, satisfiesEngineRange, compareSemver, PluginError } from './manifest';
import { createPlugin, getPluginByName, updatePluginVersion, deletePlugin } from './repository';
import { CURRENT_ENGINE_VERSION, getPluginDirs, loadPluginsForWorkspace } from './runtime';
import { extractTarGz, MAX_TARBALL_COMPRESSED_BYTES, MAX_TARBALL_BYTES, MAX_TARBALL_FILES, MAX_TARBALL_FILE_BYTES } from './tarball';

type Conn = SqliteConn | PgConn;

// ── Index format ────────────────────────────────────────────────────────────

export const MARKETPLACE_SCHEMA = 1;
export const DEFAULT_MARKETPLACE_INDEX_URL =
  'https://raw.githubusercontent.com/NiravRVaghasiya/NetPro/master/marketplace/index.json';
/** Index cap: 256 KiB of JSON is thousands of entries. */
export const MAX_INDEX_BYTES = 256 * 1024;
/** At most 1000 plugins per index. */
export const MAX_INDEX_ENTRIES = 1000;
const MAX_DESCRIPTION_LENGTH = 2000;
/** Local index cache TTL: one hour. */
const INDEX_CACHE_TTL_MS = 60 * 60 * 1000;
/** Static user agent — the fetch sends nothing about the operator. */
const MARKETPLACE_USER_AGENT = 'NetPro-marketplace/1';
const FETCH_TIMEOUT_MS = 30_000;

export interface MarketplaceTarballSource {
  type: 'tarball';
  /** Absolute https/file URL, or relative to the index URL (self-hosting). */
  url: string;
  /** Lowercase sha256 hex, required. */
  sha256: string;
}

export interface MarketplaceGitSource {
  type: 'git';
  /** https:// or file:// only — clones must be non-interactive. */
  url: string;
  /** Full 40-char commit sha the checkout is pinned to. */
  commit: string;
}

export type MarketplaceSource = MarketplaceTarballSource | MarketplaceGitSource;

export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  source: MarketplaceSource;
  /** Advisory listing shown pre-install; the tarball manifest must match it. */
  manifest: {
    permissions: {
      network?: string[];
      capabilities: PluginCapability[];
    };
  };
}

export interface MarketplaceIndex {
  schema: 1;
  updated_at: string;
  plugins: MarketplaceEntry[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getMarketplaceIndexUrl(): string {
  return process.env.MARKETPLACE_INDEX_URL?.trim() || DEFAULT_MARKETPLACE_INDEX_URL;
}

/** Reject credential-bearing or exotic URLs — the index must not smuggle secrets. */
function assertRetrievableUrl(url: string, where: string, allowHttp: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginError('invalid_index', `${where}: invalid source URL.`);
  }
  const ok =
    parsed.protocol === 'https:' || parsed.protocol === 'file:' || (allowHttp && parsed.protocol === 'http:');
  if (!ok) {
    throw new PluginError(
      'invalid_index',
      `${where}: unsupported source URL scheme ${parsed.protocol} — use https or file.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new PluginError('invalid_index', `${where}: source URLs must not contain credentials.`);
  }
  return parsed;
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Resolve a source URL against the index it was listed in. Absolute URLs
 * pass through (scheme-checked); relative URLs resolve against an http(s)
 * index URL or against the index file's directory for file/plain paths —
 * so a mirrored index + tarballs directory keeps working with no edits.
 */
export function resolveSourceUrl(indexUrl: string, sourceUrl: string): string {
  const trimmed = sourceUrl.trim();
  if (isAbsoluteUrl(trimmed)) {
    assertRetrievableUrl(trimmed, 'Marketplace source', true);
    return trimmed;
  }
  const base = indexUrl.trim();
  if (/^https?:\/\//i.test(base)) {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      throw new PluginError('unsupported_scheme', `Cannot resolve relative source URL against ${base}.`);
    }
    return resolved.href;
  }
  const baseDir = base.startsWith('file://') ? dirname(fileURLToPath(base)) : dirname(resolve(base));
  return join(baseDir, trimmed);
}

function validateSource(source: unknown, where: string): MarketplaceSource {
  if (!isPlainObject(source)) {
    throw new PluginError('invalid_index', `${where} needs a source ({ type: "tarball" | "git", ... }).`);
  }
  if (source.type === 'tarball') {
    const url = source.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw new PluginError('invalid_index', `${where}: tarball source needs a url.`);
    }
    if (isAbsoluteUrl(url.trim())) {
      assertRetrievableUrl(url.trim(), where, true);
    }
    const sha256 = source.sha256;
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new PluginError('invalid_index', `${where}: tarball source needs a sha256 hex checksum (64 chars).`);
    }
    return { type: 'tarball', url: url.trim(), sha256: sha256.toLowerCase() };
  }
  if (source.type === 'git') {
    const url = source.url;
    if (typeof url !== 'string' || (!url.trim().startsWith('https://') && !url.trim().startsWith('file://'))) {
      throw new PluginError(
        'invalid_index',
        `${where}: git source url must be https:// or file:// (clones are non-interactive — no ssh).`
      );
    }
    assertRetrievableUrl(url.trim(), where, false);
    const commit = source.commit;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
      throw new PluginError('invalid_index', `${where}: git source needs a full 40-char commit sha.`);
    }
    return { type: 'git', url: url.trim(), commit: commit.toLowerCase() };
  }
  const type = (source as Record<string, unknown>).type;
  throw new PluginError(
    'invalid_index',
    `${where}: unknown source type ${JSON.stringify(type)} — expected "tarball" or "git".`
  );
}

function validateEntry(item: unknown, position: number, seen: Set<string>): MarketplaceEntry {
  const where = `Marketplace index entry #${position}`;
  if (!isPlainObject(item)) {
    throw new PluginError('invalid_index', `${where} must be an object.`);
  }
  // Reuse the full manifest validation for name/version/permissions, so the
  // index can never list what the runtime would refuse to load.
  const itemManifest = isPlainObject(item.manifest) ? (item.manifest as Record<string, unknown>) : undefined;
  let validated: PluginManifest;
  try {
    validated = validateManifest({
      name: item.name,
      version: item.version,
      engine: '^3.0.0',
      permissions: itemManifest?.permissions,
    });
  } catch (e) {
    if (e instanceof PluginError) {
      throw new PluginError('invalid_index', `${where}: ${e.message}`);
    }
    throw e;
  }
  if (seen.has(validated.name)) {
    throw new PluginError('invalid_index', `${where}: duplicate plugin name ${validated.name}.`);
  }
  seen.add(validated.name);

  const description = item.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new PluginError('invalid_index', `${where} (${validated.name}) needs a description.`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new PluginError('invalid_index', `${where} (${validated.name}): description is too long.`);
  }
  const homepage = item.homepage;
  if (homepage !== undefined) {
    if (typeof homepage !== 'string') {
      throw new PluginError('invalid_index', `${where} (${validated.name}): homepage must be a string.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(homepage);
    } catch {
      throw new PluginError('invalid_index', `${where} (${validated.name}): invalid homepage URL.`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new PluginError('invalid_index', `${where} (${validated.name}): homepage must be http(s).`);
    }
  }
  const source = validateSource(item.source, `${where} (${validated.name})`);
  return {
    name: validated.name,
    version: validated.version,
    description: description.trim(),
    homepage: homepage as string | undefined,
    source,
    manifest: { permissions: validated.permissions },
  };
}

export function validateMarketplaceIndex(input: unknown): MarketplaceIndex {
  if (!isPlainObject(input)) {
    throw new PluginError('invalid_index', 'Marketplace index must be a JSON object.');
  }
  if (input.schema !== MARKETPLACE_SCHEMA) {
    throw new PluginError(
      'invalid_index',
      `Unsupported marketplace index schema ${JSON.stringify(input.schema)} — this NetPro reads schema ${MARKETPLACE_SCHEMA}.`
    );
  }
  const updatedAt = input.updated_at;
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new PluginError('invalid_index', 'Marketplace index updated_at must be an ISO date string.');
  }
  const plugins = input.plugins;
  if (!Array.isArray(plugins)) {
    throw new PluginError('invalid_index', 'Marketplace index plugins must be an array.');
  }
  if (plugins.length > MAX_INDEX_ENTRIES) {
    throw new PluginError(
      'too_large',
      `Marketplace index lists ${plugins.length} plugins (max ${MAX_INDEX_ENTRIES}) — refusing.`
    );
  }
  const seen = new Set<string>();
  const entries = plugins.map((item, i) => validateEntry(item, i, seen));
  return { schema: MARKETPLACE_SCHEMA, updated_at: updatedAt, plugins: entries };
}

export function searchMarketplace(index: MarketplaceIndex, term?: string): MarketplaceEntry[] {
  const query = (term ?? '').trim().toLowerCase();
  if (!query) return [...index.plugins];
  const words = query.split(/\s+/);
  return index.plugins.filter((entry) => {
    const haystack =
      `${entry.name} ${entry.description} ${entry.manifest.permissions.capabilities.join(' ')} ${(entry.manifest.permissions.network ?? []).join(' ')}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// ── Local index cache ───────────────────────────────────────────────────────

export function getIndexCachePath(): string {
  const override = process.env.MARKETPLACE_CACHE_PATH?.trim();
  if (override) return override;
  let base: string;
  try {
    base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  } catch {
    base = tmpdir();
  }
  return join(base, 'netpro', 'marketplace-index.json');
}

function cacheDisabled(): boolean {
  const value = (process.env.MARKETPLACE_NO_CACHE ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function readIndexCache(indexUrl: string): Promise<string | null> {
  if (cacheDisabled()) return null;
  try {
    // Ignore for bundler tracing: the cache lives outside the project.
    const cachePath = getIndexCachePath();
    const raw = await readFile(/* turbopackIgnore: true */ cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { url?: unknown; fetchedAt?: unknown; body?: unknown };
    if (parsed.url !== indexUrl) return null;
    if (typeof parsed.fetchedAt !== 'number' || Date.now() - parsed.fetchedAt > INDEX_CACHE_TTL_MS) return null;
    if (typeof parsed.body !== 'string' || parsed.body.length > MAX_INDEX_BYTES) return null;
    return parsed.body;
  } catch {
    return null;
  }
}

async function writeIndexCache(indexUrl: string, body: string): Promise<void> {
  if (cacheDisabled()) return;
  try {
    const path = getIndexCachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ url: indexUrl, fetchedAt: Date.now(), body }), 'utf8');
  } catch {
    // The cache is best-effort (read-only filesystems, serverless).
  }
}

// ── Download ────────────────────────────────────────────────────────────────

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

async function readCappedResponse(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new PluginError('too_large', `${what} exceeds the ${maxBytes}-byte limit — refusing.`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new PluginError('too_large', `${what} exceeds the ${maxBytes}-byte limit — refusing.`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PluginError('too_large', `${what} exceeds the ${maxBytes}-byte limit — refusing.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** A filesystem path for file:// URLs and bare paths; null for http(s). */
function toLocalPath(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      throw new PluginError('fetch_failed', `Invalid file URL: ${url}`);
    }
  }
  if (isAbsoluteUrl(url)) return null;
  return resolve(url);
}

async function readLocalBytes(path: string, maxBytes: number, what: string): Promise<Buffer> {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new PluginError('fetch_failed', `${what} not found: ${path}`);
  }
  if (!stats.isFile()) {
    throw new PluginError('fetch_failed', `${what} is not a file: ${path}`);
  }
  if (stats.size > maxBytes) {
    throw new PluginError('too_large', `${what} exceeds the ${maxBytes}-byte limit — refusing.`);
  }
  try {
    return await readFile(path);
  } catch (e) {
    throw new PluginError('fetch_failed', `${what} could not be read: ${(e as Error).message}`);
  }
}

export async function downloadBytes(
  url: string,
  opts: { fetchImpl?: FetchImpl; maxBytes: number; what: string }
): Promise<Buffer> {
  const local = toLocalPath(url);
  if (local) return readLocalBytes(local, opts.maxBytes, opts.what);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginError('fetch_failed', `Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PluginError('unsupported_scheme', `Cannot download ${url}: only https and file URLs are supported.`);
  }
  if (parsed.username || parsed.password) {
    throw new PluginError('unsupported_scheme', 'Download URLs must not contain credentials.');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetchImpl(url, {
        headers: { 'user-agent': MARKETPLACE_USER_AGENT },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    if (e instanceof PluginError) throw e;
    throw new PluginError('fetch_failed', `Could not download ${opts.what}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new PluginError('fetch_failed', `Could not download ${opts.what}: HTTP ${res.status}.`);
  }
  return readCappedResponse(res, opts.maxBytes, opts.what);
}

export interface FetchIndexOptions {
  fetchImpl?: FetchImpl;
  indexUrl?: string;
  refresh?: boolean;
}

export async function fetchMarketplaceIndex(
  opts: FetchIndexOptions = {}
): Promise<{ index: MarketplaceIndex; indexUrl: string; fromCache: boolean }> {
  const indexUrl = (opts.indexUrl ?? getMarketplaceIndexUrl()).trim();
  if (!indexUrl) {
    throw new PluginError('invalid_index', 'Marketplace index URL is empty.');
  }
  if (!opts.refresh) {
    const cached = await readIndexCache(indexUrl);
    if (cached !== null) {
      try {
        return { index: validateMarketplaceIndex(JSON.parse(cached)), indexUrl, fromCache: true };
      } catch {
        // Stale or invalid cache — refetch below.
      }
    }
  }
  const bytes = await downloadBytes(indexUrl, {
    fetchImpl: opts.fetchImpl,
    maxBytes: MAX_INDEX_BYTES,
    what: 'Marketplace index',
  });
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginError('invalid_index', 'Marketplace index is not valid JSON.');
  }
  const index = validateMarketplaceIndex(parsed);
  await writeIndexCache(indexUrl, text);
  return { index, indexUrl, fromCache: false };
}

// ── Checksum verification ───────────────────────────────────────────────────

export function verifySha256Hex(data: Buffer, expectedHex: string): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex.toLowerCase(), 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32) return false;
  return timingSafeEqual(createHash('sha256').update(data).digest(), expected);
}

export async function downloadAndVerifyTarball(
  url: string,
  sha256: string,
  opts: { fetchImpl?: FetchImpl } = {}
): Promise<Buffer> {
  const bytes = await downloadBytes(url, {
    fetchImpl: opts.fetchImpl,
    maxBytes: MAX_TARBALL_COMPRESSED_BYTES,
    what: `Plugin tarball ${url}`,
  });
  if (!verifySha256Hex(bytes, sha256)) {
    throw new PluginError(
      'checksum_mismatch',
      `Checksum mismatch for ${url}: the download does not match the index sha256 — refusing to install.`
    );
  }
  return bytes;
}

// ── Plugin directory ────────────────────────────────────────────────────────

export function resolvePluginInstallDir(explicit?: string): string {
  const fromArg = explicit?.trim();
  if (fromArg) return resolve(fromArg);
  const fromEnv = process.env.NETPRO_PLUGIN_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  // First existing load root, else ./plugins (created on install) — always
  // one of the directories the runtime discovers, so installs are loadable.
  const dirs = getPluginDirs();
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }
  return dirs[0]!;
}

export async function removePluginFiles(installDir: string, name: string): Promise<boolean> {
  const base = resolve(installDir);
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new PluginError('invalid_input', `Refusing to remove ${JSON.stringify(name)}: escapes the plugin directory.`);
  }
  try {
    await stat(target);
  } catch {
    return false;
  }
  await rm(target, { recursive: true, force: true });
  return true;
}

// ── Git sources ─────────────────────────────────────────────────────────────

export interface GitSourceOptions {
  timeoutMs?: number;
}

function copyTreeCapped(src: string, dest: string, pluginName: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const srcPath = join(from, entry.name);
      const destPath = join(to, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PluginError('invalid_input', `Git source for ${pluginName} contains a symlink (refused): ${entry.name}`);
      }
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new PluginError(
          'invalid_input',
          `Git source for ${pluginName} contains a non-file entry (refused): ${entry.name}`
        );
      }
      files++;
      if (files > MAX_TARBALL_FILES) {
        throw new PluginError('too_large', `Git source exceeds the ${MAX_TARBALL_FILES}-file limit — refusing.`);
      }
      const data = readFileSync(srcPath);
      bytes += data.length;
      if (data.length > MAX_TARBALL_FILE_BYTES || bytes > MAX_TARBALL_BYTES) {
        throw new PluginError('too_large', 'Git source exceeds the size limit — refusing.');
      }
      writeFileSync(destPath, data, { mode: 0o644 });
    }
  };
  walk(src, dest);
}

/**
 * Clone a git source and check out the pinned commit into `destDir` (without
 * its .git directory). No shell, no credentials, non-interactive: the URL
 * must be https:// or file:// and the commit a full sha.
 */
export function installFromGitSource(
  url: string,
  commit: string,
  destDir: string,
  opts: GitSourceOptions = {}
): void {
  if (!url.startsWith('https://') && !url.startsWith('file://')) {
    throw new PluginError('git_source_failed', `Git source URL must be https:// or file://: ${url}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new PluginError('git_source_failed', 'Git source needs a full 40-char commit sha.');
  }
  const timeout = opts.timeoutMs ?? 120_000;
  const tmp = mkdtempSync(join(tmpdir(), 'netpro-plugin-'));
  try {
    try {
      execFileSync('git', ['clone', '--no-checkout', '--quiet', url, tmp], { timeout, stdio: 'pipe' });
      execFileSync('git', ['-C', tmp, 'checkout', '--quiet', commit], { timeout, stdio: 'pipe' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginError('git_source_failed', 'The git binary was not found — git sources need git installed.');
      }
      const firstLine = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
      throw new PluginError('git_source_failed', `Git clone/checkout failed for ${url}: ${firstLine}`);
    }
    let head: string;
    try {
      head = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { timeout, stdio: 'pipe' }).toString().trim();
    } catch {
      throw new PluginError('git_source_failed', `Could not verify the checked-out commit for ${url}.`);
    }
    if (head.toLowerCase() !== commit.toLowerCase()) {
      throw new PluginError(
        'git_source_failed',
        `Git source HEAD ${head} does not match the pinned commit ${commit} — refusing.`
      );
    }
    copyTreeCapped(tmp, destDir, destDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Install / update / remove orchestration ────────────────────────────────

export interface MarketplaceOpOptions {
  scope?: WorkspaceScope;
  fetchImpl?: FetchImpl;
  indexUrl?: string;
  /** A pre-fetched index (tests, or callers that already listed it). */
  index?: MarketplaceIndex;
  pluginDir?: string;
  refresh?: boolean;
}

export interface MarketplaceInstallResult {
  plugin: PluginListItem;
  entry: MarketplaceEntry;
  dir: string;
  indexUrl: string;
}

export interface MarketplaceUpdateResult extends MarketplaceInstallResult {
  updated: boolean;
  fromVersion: string;
}

async function resolveEntry(
  name: string,
  opts: MarketplaceOpOptions
): Promise<{ entry: MarketplaceEntry; indexUrl: string }> {
  let index = opts.index;
  let indexUrl = (opts.indexUrl ?? getMarketplaceIndexUrl()).trim();
  if (!index) {
    const fetched = await fetchMarketplaceIndex({
      fetchImpl: opts.fetchImpl,
      indexUrl,
      refresh: opts.refresh,
    });
    index = fetched.index;
    indexUrl = fetched.indexUrl;
  }
  const trimmed = name.trim();
  const entry = index.plugins.find((candidate) => candidate.name === trimmed);
  if (!entry) {
    throw new PluginError('not_found', `Plugin ${trimmed || '(empty)'} is not in the marketplace index (${indexUrl}).`);
  }
  return { entry, indexUrl };
}

function permissionsEqual(
  a: PluginManifest['permissions'],
  b: PluginManifest['permissions']
): boolean {
  const capabilitiesA = [...a.capabilities].sort();
  const capabilitiesB = [...b.capabilities].sort();
  if (capabilitiesA.length !== capabilitiesB.length) return false;
  if (capabilitiesA.some((capability, i) => capability !== capabilitiesB[i])) return false;
  const networkA = [...(a.network ?? [])].map((host) => host.toLowerCase()).sort();
  const networkB = [...(b.network ?? [])].map((host) => host.toLowerCase()).sort();
  if (networkA.length !== networkB.length) return false;
  return networkA.every((host, i) => host === networkB[i]);
}

async function readExtractedManifest(dir: string, entryName: string): Promise<PluginManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new PluginError(
      'invalid_manifest',
      `Plugin ${entryName} has no manifest.json at the archive root — refusing to install.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginError('invalid_manifest', `Plugin ${entryName} manifest.json is not valid JSON.`);
  }
  return validateManifest(parsed);
}

/** The archive is authoritative for code but must agree with the listing. */
function assertManifestMatchesIndex(entry: MarketplaceEntry, manifest: PluginManifest): void {
  if (manifest.name !== entry.name) {
    throw new PluginError(
      'manifest_mismatch',
      `Manifest mismatch for ${entry.name}: the archive contains plugin ${manifest.name} — refusing to install.`
    );
  }
  if (manifest.version !== entry.version) {
    throw new PluginError(
      'manifest_mismatch',
      `Manifest mismatch for ${entry.name}: the index lists ${entry.version} but the archive contains ${manifest.version} — refusing to install.`
    );
  }
  if (!permissionsEqual(manifest.permissions, entry.manifest.permissions)) {
    throw new PluginError(
      'manifest_mismatch',
      `Manifest mismatch for ${entry.name}: permissions in the archive differ from the index listing — refusing to install.`
    );
  }
}

function installedFromLabel(entry: MarketplaceEntry): string {
  return `marketplace:${entry.name}@${entry.version}`;
}

async function materializeSource(
  indexUrl: string,
  entry: MarketplaceEntry,
  destDir: string,
  fetchImpl?: FetchImpl
): Promise<void> {
  if (entry.source.type === 'tarball') {
    const sourceUrl = resolveSourceUrl(indexUrl, entry.source.url);
    const bytes = await downloadAndVerifyTarball(sourceUrl, entry.source.sha256, { fetchImpl });
    await extractTarGz(bytes, destDir);
    return;
  }
  installFromGitSource(entry.source.url, entry.source.commit, destDir);
}

/**
 * Install a marketplace plugin: download, checksum-verify, extract into the
 * plugin directory, verify the manifest against the index listing, and
 * register it **disabled** — the permissions review gate on enable (Phase 5)
 * is what turns it on. Refusals are audited as `plugin.install_failed`.
 */
export async function installPluginFromMarketplace(
  conn: Conn,
  name: string,
  opts: MarketplaceOpOptions = {}
): Promise<MarketplaceInstallResult> {
  const resolved = resolveScope(opts.scope);
  const { entry, indexUrl } = await resolveEntry(name, opts);

  const existing = await getPluginByName(conn, entry.name, opts.scope);
  if (existing) {
    throw new PluginError(
      'conflict',
      `Plugin ${entry.name} is already installed (${existing.version}). Use update instead.`
    );
  }

  const installDir = resolvePluginInstallDir(opts.pluginDir);
  const target = join(installDir, entry.name);
  // Never overwrite a non-empty directory on install — update owns that path.
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      const children = await readdir(target);
      if (children.length > 0) {
        throw new PluginError(
          'conflict',
          `Plugin directory ${target} already exists and is not empty — remove it first, or install a different plugin.`
        );
      }
    } else {
      throw new PluginError('conflict', `Plugin path ${target} already exists as a file — remove it first.`);
    }
  } catch (e) {
    if (e instanceof PluginError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  let manifest: PluginManifest;
  try {
    await mkdir(installDir, { recursive: true });
    await materializeSource(indexUrl, entry, target, opts.fetchImpl);
    manifest = await readExtractedManifest(target, entry.name);
    assertManifestMatchesIndex(entry, manifest);
    if (!satisfiesEngineRange(CURRENT_ENGINE_VERSION, manifest.engine)) {
      throw new PluginError(
        'engine_mismatch',
        `Plugin ${entry.name}@${entry.version} requires NetPro ${manifest.engine} but this is ${CURRENT_ENGINE_VERSION} — refusing to install.`
      );
    }
  } catch (e) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    await writeActivityLog(
      conn,
      {
        action: 'plugin.install_failed',
        entityType: 'plugin',
        entityId: entry.name,
        metadata: {
          reason: e instanceof PluginError ? e.code : 'unknown',
          workspaceId: resolved.workspaceId,
        },
      },
      opts.scope
    ).catch(() => {});
    throw e;
  }

  const plugin = await createPlugin(
    conn,
    {
      name: manifest.name,
      version: manifest.version,
      manifest,
      installedFrom: installedFromLabel(entry),
      installedByUser: resolved.userId,
    },
    opts.scope
  );
  await writeActivityLog(
    conn,
    {
      action: 'plugin.installed',
      entityType: 'plugin',
      entityId: entry.name,
      metadata: { version: entry.version, source: installedFromLabel(entry), workspaceId: resolved.workspaceId },
    },
    opts.scope
  );
  return { plugin, entry, dir: target, indexUrl };
}

/**
 * Install-over update with version monotonicity: newer versions apply,
 * identical versions are a no-op, downgrades are refused unless `force`.
 * The enabled state and settings survive; an enabled plugin is reloaded.
 */
export async function updatePluginFromMarketplace(
  conn: Conn,
  name: string,
  opts: MarketplaceOpOptions & { force?: boolean } = {}
): Promise<MarketplaceUpdateResult> {
  const resolved = resolveScope(opts.scope);
  const { entry, indexUrl } = await resolveEntry(name, opts);

  const existing = await getPluginByName(conn, entry.name, opts.scope);
  if (!existing) {
    throw new PluginError('not_found', `Plugin ${entry.name} is not installed — use install instead.`);
  }
  const comparison = compareSemver(entry.version, existing.version);
  const installDir = resolvePluginInstallDir(opts.pluginDir);
  const target = join(installDir, entry.name);
  if (comparison === 0) {
    return { updated: false, plugin: existing, entry, dir: target, indexUrl, fromVersion: existing.version };
  }
  if (comparison < 0 && !opts.force) {
    await writeActivityLog(
      conn,
      {
        action: 'plugin.update_refused',
        entityType: 'plugin',
        entityId: entry.name,
        metadata: {
          reason: 'downgrade_refused',
          from: existing.version,
          to: entry.version,
          workspaceId: resolved.workspaceId,
        },
      },
      opts.scope
    );
    throw new PluginError(
      'downgrade_refused',
      `Marketplace has ${entry.name}@${entry.version} but ${existing.version} is installed — refusing to downgrade (pass --force to override).`
    );
  }

  // Stage into a temp dir first: a failed update must never leave a half
  // tree behind, and the live dir is only touched once verified.
  const staging = await mkdtemp(join(tmpdir(), 'netpro-plugin-update-'));
  let manifest: PluginManifest;
  try {
    await materializeSource(indexUrl, entry, staging, opts.fetchImpl);
    manifest = await readExtractedManifest(staging, entry.name);
    assertManifestMatchesIndex(entry, manifest);
    if (!satisfiesEngineRange(CURRENT_ENGINE_VERSION, manifest.engine)) {
      throw new PluginError(
        'engine_mismatch',
        `Plugin ${entry.name}@${entry.version} requires NetPro ${manifest.engine} but this is ${CURRENT_ENGINE_VERSION} — refusing to update.`
      );
    }
    await mkdir(installDir, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(staging, target, { recursive: true });
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await writeActivityLog(
      conn,
      {
        action: 'plugin.update_failed',
        entityType: 'plugin',
        entityId: entry.name,
        metadata: { reason: e instanceof PluginError ? e.code : 'unknown', workspaceId: resolved.workspaceId },
      },
      opts.scope
    ).catch(() => {});
    throw e;
  }
  await rm(`${staging}-done`, { recursive: true, force: true }).catch(() => {});
  await rm(staging, { recursive: true, force: true }).catch(() => {});

  const plugin = await updatePluginVersion(
    conn,
    entry.name,
    { version: manifest.version, manifest, installedFrom: installedFromLabel(entry) },
    opts.scope
  );
  await writeActivityLog(
    conn,
    {
      action: 'plugin.updated',
      entityType: 'plugin',
      entityId: entry.name,
      metadata: { from: existing.version, to: manifest.version, workspaceId: resolved.workspaceId },
    },
    opts.scope
  );
  if (existing.enabled) {
    try {
      await loadPluginsForWorkspace(conn, opts.scope);
    } catch {
      // loadPluginsForWorkspace audits its own failures per plugin.
    }
  }
  return { updated: true, plugin, entry, dir: target, indexUrl, fromVersion: existing.version };
}

/**
 * Unregister a plugin and delete its files (Phase 6 owns both halves of
 * `rm`). An enabled plugin's capabilities are unloaded by reloading the
 * remaining enabled plugins.
 */
export async function uninstallPlugin(
  conn: Conn,
  name: string,
  opts: { scope?: WorkspaceScope; pluginDir?: string } = {}
): Promise<{ filesRemoved: boolean }> {
  const trimmed = name.trim();
  const existing = await getPluginByName(conn, trimmed, opts.scope);
  if (!existing) {
    throw new PluginError('not_found', `Plugin ${trimmed || '(empty)'} is not installed.`);
  }
  await deletePlugin(conn, existing.name, opts.scope);
  const filesRemoved = await removePluginFiles(resolvePluginInstallDir(opts.pluginDir), existing.name);
  const resolved = resolveScope(opts.scope);
  await writeActivityLog(
    conn,
    {
      action: 'plugin.removed',
      entityType: 'plugin',
      entityId: existing.name,
      metadata: { workspaceId: resolved.workspaceId, filesRemoved },
    },
    opts.scope
  );
  if (existing.enabled) {
    try {
      await loadPluginsForWorkspace(conn, opts.scope);
    } catch {
      // loadPluginsForWorkspace audits its own failures per plugin.
    }
  }
  return { filesRemoved };
}
