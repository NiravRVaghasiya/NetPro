// Local installation identity and local API token (local-first Phase 5).
//
// Local NetPro has no accounts and no OAuth provider. The installation is the
// identity: `~/.netpro` is owned by one person on one machine, and the local
// server trusts requests that arrive over loopback. This module owns the two
// pieces of that model that live on disk:
//
//   1. `[installation]` in `~/.netpro/config.toml`
//
//          [installation]
//          id = "ins_9f2c…"
//          created_at = "2026-09-10T12:00:00.000Z"
//          owner = "Alex"            # optional display name
//
//      Minted once by `netpro init` and never regenerated: it identifies the
//      install across backups, exports, and future multi-install setups
//      without ever identifying a person to a third party.
//
//   2. `~/.netpro/keys/access-token` (mode 0600)
//
//      A bearer token used ONLY when the server is deliberately exposed
//      beyond loopback (`netpro serve --host 0.0.0.0` or a reverse proxy).
//      Loopback callers never need it. It is never written to config.toml and
//      never logged in full.
//
// Like `./local`, this module imports only node: builtins — the CLI keychain
// and the server both import it without pulling in a database driver.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  configTomlPath,
  ensureNetProHome,
  LocalConfigError,
  netproHome,
  readLocalConfig,
  type LocalInstallationConfig,
} from './local';

// ── Installation identity ────────────────────────────────────────────────

/** Prefix on generated installation ids, so a stray id is self-describing. */
export const INSTALLATION_ID_PREFIX = 'ins_';

/** `ins_` + 24 hex characters = 12 random bytes. */
export function generateInstallationId(): string {
  return `${INSTALLATION_ID_PREFIX}${randomBytes(12).toString('hex')}`;
}

export type InstallationIdentity = {
  id: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Optional display name for the owner of this install. */
  owner?: string;
  /** Optional contact address (display only; NetPro never transmits it). */
  email?: string;
};

/**
 * Read the installation identity from `config.toml`.
 *
 * Returns `null` when the file has no `[installation] id` — an install that
 * predates this phase, or one created by hand. Callers decide whether that is
 * fatal (`netpro serve` warns) or fixable (`netpro init` writes one).
 */
export function readInstallationIdentity(
  env: NodeJS.ProcessEnv = process.env
): InstallationIdentity | null {
  const config = readLocalConfig(env);
  const table: LocalInstallationConfig | undefined = config.installation;
  const id = typeof table?.id === 'string' ? table.id.trim() : '';
  if (!id) return null;
  return {
    id,
    createdAt:
      typeof table?.createdAt === 'string' && table.createdAt.trim() !== ''
        ? table.createdAt.trim()
        : '',
    ...(table?.owner ? { owner: table.owner } : {}),
    ...(table?.email ? { email: table.email } : {}),
  };
}

export type EnsureIdentityOptions = {
  /** Display name to record on first creation (ignored when one exists). */
  owner?: string;
  email?: string;
  /** Injectable clock/id (tests). */
  now?: Date;
  id?: string;
};

export type EnsureIdentityResult = {
  identity: InstallationIdentity;
  /** True when this call minted (and wrote) a new identity. */
  created: boolean;
};

/**
 * Return the installation identity, minting and persisting one if absent.
 *
 * Idempotent: an existing identity is returned untouched, including when the
 * caller passes an `owner`. `netpro init` is the normal caller.
 */
export function ensureInstallationIdentity(
  env: NodeJS.ProcessEnv = process.env,
  options: EnsureIdentityOptions = {}
): EnsureIdentityResult {
  const existing = readInstallationIdentity(env);
  if (existing) return { identity: existing, created: false };

  const identity: InstallationIdentity = {
    id: options.id ?? generateInstallationId(),
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(options.owner?.trim() ? { owner: options.owner.trim() } : {}),
    ...(options.email?.trim() ? { email: options.email.trim() } : {}),
  };
  writeInstallationIdentity(identity, env);
  return { identity, created: true };
}

/**
 * Persist an installation identity into `config.toml`.
 *
 * Creates `~/.netpro/config.toml` when missing and merges into an existing
 * `[installation]` section key-by-key: values already present win, so an
 * identity is never rewritten behind the user's back. Every other section and
 * comment in the file is preserved byte-for-byte.
 */
export function writeInstallationIdentity(
  identity: InstallationIdentity,
  env: NodeJS.ProcessEnv = process.env
): string {
  ensureNetProHome(env);
  const path = configTomlPath(env);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = upsertInstallationSection(current, identity);
  writeFileSync(path, next, { mode: 0o644 });
  return path;
}

/** Keys NetPro writes into `[installation]`, in display order. */
function identityEntries(identity: InstallationIdentity): Array<[string, string]> {
  const entries: Array<[string, string]> = [['id', identity.id]];
  if (identity.createdAt) entries.push(['created_at', identity.createdAt]);
  if (identity.owner) entries.push(['owner', identity.owner]);
  if (identity.email) entries.push(['email', identity.email]);
  return entries;
}

/**
 * Merge an identity into a config.toml document.
 *
 * Fill-in-the-blanks, never overwrite: keys already present in the file win
 * (including a hand-edited `owner`, or a field a future version understands
 * and this one does not), and every comment and blank line is preserved. The
 * TOML subset NetPro accepts is flat — no dotted keys, no inline tables — so
 * section surgery is a line scan rather than a parser round-trip.
 *
 * Exported for tests.
 */
export function upsertInstallationSection(
  text: string,
  identity: InstallationIdentity
): string {
  const entries = identityEntries(identity);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === '[installation]');

  if (headerIndex === -1) {
    const body = entries.map(([key, value]) => `${key} = ${tomlString(value)}`);
    if (text.trim() === '') return [`[installation]`, ...body, ''].join(eol);
    const prefix = text.endsWith('\n') ? `${text}${eol}` : `${text}${eol}${eol}`;
    return `${prefix}[installation]${eol}${body.join(eol)}${eol}`;
  }

  // Find the end of the existing [installation] section and what it defines.
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('[')) {
      end = i;
      break;
    }
  }
  const present = new Set<string>();
  for (let i = headerIndex + 1; i < end; i++) {
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec((lines[i] ?? '').trim());
    if (match?.[1]) present.add(match[1]);
  }

  const missing = entries.filter(([key]) => !present.has(key));
  if (missing.length === 0) return text;

  // Insert directly under the header, above the user's own keys and comments.
  const inserted = missing.map(([key, value]) => `${key} = ${tomlString(value)}`);
  const rebuilt = [
    ...lines.slice(0, headerIndex + 1),
    ...inserted,
    ...lines.slice(headerIndex + 1),
  ];
  return rebuilt.join(eol);
}

/** Minimal TOML basic-string encoding for the values NetPro writes. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── Local API token ──────────────────────────────────────────────────────

/** Prefix on generated API tokens, so a leaked string is identifiable. */
export const ACCESS_TOKEN_PREFIX = 'np_';

/** `~/.netpro/keys/access-token`. */
export function accessTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(netproHome(env), 'keys', 'access-token');
}

/** 32 random bytes, base64url — 256 bits of entropy, URL/header safe. */
export function generateAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * The token on disk, or `null`. Never throws: an unreadable or empty file is
 * the same as "no token", because the caller's fallback (loopback trust) is
 * safe by default.
 */
export function readAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = accessTokenPath(env);
  if (!existsSync(path)) return null;
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * Write a token to `~/.netpro/keys/access-token` with mode 0600.
 * Returns the path written.
 */
export function writeAccessToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = token.trim();
  if (value === '') throw new LocalConfigError('Refusing to write an empty access token.');
  const path = accessTokenPath(env);
  mkdirSync(join(netproHome(env), 'keys'), { recursive: true });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when creating; fix up pre-existing files.
  chmodSync(path, 0o600);
  return path;
}

/**
 * Effective token for this process.
 *
 * `NETPRO_AUTH_TOKEN` first: containers and orchestrators inject secrets this
 * way, and a mounted secret should not require a writable home directory.
 * Otherwise the install's `keys/access-token`.
 */
export function resolveAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.NETPRO_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readAccessToken(env);
}

export type EnsureAccessTokenResult = {
  token: string;
  path: string;
  /** True when this call minted (and wrote) a new token. */
  created: boolean;
};

/**
 * Return the access token, minting and writing one if absent.
 *
 * Idempotent. Used by `netpro init` and by `netpro serve` when it is asked to
 * bind beyond loopback, so a remote bind is never accidentally unprotected.
 */
export function ensureAccessToken(
  env: NodeJS.ProcessEnv = process.env
): EnsureAccessTokenResult {
  const existing = readAccessToken(env);
  if (existing) return { token: existing, path: accessTokenPath(env), created: false };
  const token = generateAccessToken();
  const path = writeAccessToken(token, env);
  return { token, path, created: true };
}

/**
 * Display form of a token: enough to identify it, never enough to use it.
 * `np_2c9…Kf4` (last 4 characters) is what `netpro token --show` prints by
 * default and what appears in banners.
 */
export function redactAccessToken(token: string): string {
  const value = token.trim();
  if (value.length <= 8) return '****';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
