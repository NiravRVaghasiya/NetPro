// Local installation layout and database configuration (Phase 3 — local-first).
//
// A local NetPro install is a single directory, `~/.netpro` by default:
//
//     ~/.netpro/
//     ├── config.toml   ← user-editable configuration (database, server, auth,
//     │                    installation identity)
//     ├── netpro.db     ← SQLite database (the default dialect)
//     ├── logs/
//     └── keys/
//         └── access-token   ← local API token (Phase 5; remote requests only)
//
// `NETPRO_HOME` relocates the whole install (tests, portable installs, and
// multi-instance setups use this — nothing else needs to change).
//
// This module deliberately imports only node:os/node:path/node:fs. The CLI's
// keychain imports it so secrets follow the same install directory without
// dragging better-sqlite3 into commands that never touch the database, and the
// server imports it so `netpro serve` and `~/.netpro/config.toml` agree on one
// configuration story.
//
// Config precedence for every database setting (highest wins):
//
//     1. explicit environment variables  (DB_DIALECT / DB_PATH / DATABASE_URL)
//     2. ~/.netpro/config.toml           ([database] dialect / path / url)
//     3. defaults                        (SQLite at ~/.netpro/netpro.db)
//
// so a fresh machine needs no DATABASE_URL and no environment at all — which
// is the point of this phase.
//
// Phase 4 removed the last cloud-specific behaviour from this file: a set
// `DATABASE_URL` no longer implies PostgreSQL just because the process looks
// like it is running on a hosted platform. The dialect is what the user (or
// their config file) says it is, defaulting to SQLite.

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// ── Install directory ────────────────────────────────────────────────────

/**
 * The local install directory: `NETPRO_HOME` when set, otherwise `~/.netpro`.
 *
 * Does not create the directory — use `ensureNetProHome()` for that, so read
 * paths (config lookup) never have the side effect of writing to disk.
 */
export function netproHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NETPRO_HOME?.trim();
  if (override) return expandHomePath(override, env);
  return join(homedir(), '.netpro');
}

/** Path of the local config file inside the install directory. */
export function configTomlPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(netproHome(env), 'config.toml');
}

/** Default SQLite database path: `<home>/netpro.db`. */
export function defaultSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(netproHome(env), 'netpro.db');
}

/**
 * Expand a leading `~/` (or `~\`) to the user's home directory. Paths that are
 * not home-relative are returned unchanged.
 */
export function expandHomePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Resolve a configured SQLite path to an absolute one.
 *
 * Relative paths in `config.toml` are resolved against the install directory,
 * not the process cwd, so `path = "netpro.db"` means the same thing no matter
 * where `netpro serve` was started. (`DB_PATH` keeps its historical cwd-based
 * behaviour — it is an operator override, not a config-file value.)
 */
export function resolveSqlitePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const expanded = expandHomePath(path, env);
  if (isAbsolute(expanded)) return expanded;
  return resolve(netproHome(env), expanded);
}

/**
 * Create the install directory (and any parent of a SQLite file) on disk.
 * Idempotent. `:memory:` needs no directory and is ignored.
 */
export function ensureSqliteDir(sqlitePath: string): void {
  if (sqlitePath === ':memory:') return;
  mkdirSync(dirname(sqlitePath), { recursive: true });
}

/**
 * Create `~/.netpro` plus its fixed subdirectories. Idempotent.
 *
 * Phase 23 — the install directory holds the database, the access token, and
 * backups: the whole professional network in one place. Everything here is
 * mode 0700 (owner-only), applied on every call so installs created before
 * this phase tighten up the next time they are touched.
 */
export function ensureNetProHome(env: NodeJS.ProcessEnv = process.env): {
  home: string;
  logs: string;
  keys: string;
} {
  const home = netproHome(env);
  const logs = join(home, 'logs');
  const keys = join(home, 'keys');
  mkdirSync(logs, { recursive: true });
  mkdirSync(keys, { recursive: true });
  chmodSync(home, 0o700);
  chmodSync(logs, 0o700);
  chmodSync(keys, 0o700);
  return { home, logs, keys };
}

// ── config.toml parsing (small, strict TOML subset) ──────────────────────
//
// NetPro's own config file is intentionally simple (the plan's example is
// two keys under [database]). A ~100-line parser for that subset — sections,
// strings, integers, floats, booleans, comments — keeps the local-first path
// dependency-free and honest: anything outside the subset is a loud error
// with a line number, never a silently ignored key.

export type TomlValue = string | number | boolean | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

export type ParsedToml = { table: TomlTable };

class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(`config.toml line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

function parseTomlString(raw: string, line: number): string {
  if (raw.startsWith("'")) {
    // Literal string: no escapes, ends at the next single quote.
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new TomlError('unterminated literal string (missing closing \')', line);
    }
    return raw.slice(1, -1);
  }
  if (!raw.startsWith('"')) throw new TomlError(`expected a string, got ${raw}`, line);
  if (!raw.endsWith('"') || raw.length < 2) {
    throw new TomlError('unterminated string (missing closing ")', line);
  }
  const body = raw.slice(1, -1);
  // Basic-string escapes (the common subset; \uXXXX included for completeness).
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) throw new TomlError('dangling backslash in string', line);
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case 'u':
      case 'U': {
        const width = next === 'u' ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          throw new TomlError(`invalid unicode escape \\${next}${hex}`, line);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        i += width;
        break;
      }
      default:
        throw new TomlError(`unsupported escape \\${next}`, line);
    }
  }
  return out;
}

function parseTomlValue(raw: string, line: number): TomlValue {
  const value = raw.trim();
  if (value === '') throw new TomlError('missing value after "="', line);
  if (value === 'true') return true;
  if (value === 'false') return false;
  const first = value[0];
  if (first === '"' || first === "'") return parseTomlString(value, line);
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?(\d+\.\d+|\.\d+|\d+\.)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (/^[+-]?(\d+(\.\d+)?)([eE][+-]?\d+)$/.test(value)) return Number(value);
  throw new TomlError(`unsupported value "${value}" (NetPro's config subset allows strings, numbers, and booleans)`, line);
}

/**
 * Parse a config.toml subset: `[section]` headers, `key = value` pairs
 * (strings, integers, floats, booleans), `#` comments, blank lines, and
 * trailing comments after values. Multi-line structures (arrays, inline
 * tables, multi-line strings), dotted keys, and duplicate keys are rejected
 * with a line-numbered error so a typo can never be silently dropped.
 */
export function parseToml(text: string): ParsedToml {
  const table: TomlTable = {};
  let current: TomlTable = table;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const rawLine = lines[index] ?? ''; // split() never yields holes — satisfies noUncheckedIndexedAccess
    let line = rawLine;

    const hash = stripComment(line);
    line = hash.text.trim();
    if (line === '') continue;

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new TomlError('unterminated table header (missing "]")', lineNo);
      const name = line.slice(1, -1).trim();
      if (name === '') throw new TomlError('empty table header', lineNo);
      if (name.includes('.')) {
        throw new TomlError('dotted table names are not supported by NetPro\'s config subset', lineNo);
      }
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new TomlError(`invalid table name "${name}"`, lineNo);
      }
      const existing = table[name];
      if (existing !== undefined) {
        throw new TomlError(`table [${name}] is defined more than once`, lineNo);
      }
      current = {};
      table[name] = current;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) throw new TomlError(`expected "key = value", got "${line}"`, lineNo);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new TomlError(`invalid key "${key}"`, lineNo);
    }
    if (key in current) {
      throw new TomlError(`duplicate key "${key}"`, lineNo);
    }
    const rawValue = line.slice(eq + 1).trim();
    if (rawValue.startsWith('[') || rawValue.startsWith('{') || rawValue.startsWith('"""') || rawValue.startsWith("'''")) {
      throw new TomlError('multi-line values, arrays, and inline tables are not supported by NetPro\'s config subset', lineNo);
    }
    current[key] = parseTomlValue(rawValue, lineNo);
  }

  return { table };
}

/** Strip a `#` comment, respecting `#` inside quoted strings. */
function stripComment(line: string): { text: string; hadComment: boolean } {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inLiteral) inBasic = !inBasic;
    else if (ch === "'" && !inBasic) inLiteral = !inLiteral;
    else if (ch === '#' && !inBasic && !inLiteral) {
      return { text: line.slice(0, i), hadComment: true };
    }
  }
  return { text: line, hadComment: false };
}

// ── Typed access to the local config ─────────────────────────────────────

export type LocalDatabaseConfig = {
  dialect?: unknown;
  path?: unknown;
  url?: unknown;
};

/**
 * `[installation]` — the local installation identity (Phase 5).
 *
 * Local NetPro has no user accounts to log into: the install itself is the
 * owner. `netpro init` mints this once and never regenerates it, so data,
 * keys, and exports can always be attributed to the same local installation.
 */
export type LocalInstallationConfig = {
  id?: string;
  /** ISO-8601 timestamp of when the installation was created. */
  createdAt?: string;
  /** Display name for the owner (used by the local UI; optional). */
  owner?: string;
  /** Contact email for the owner (optional; never sent anywhere). */
  email?: string;
};

/** Authentication mode for the local server (Phase 5). */
export type LocalAuthMode = 'local' | 'token' | 'open';

/** Alias so callers can say `AuthMode` without caring which layer they are in. */
export type AuthMode = LocalAuthMode;

export const AUTH_MODES: readonly LocalAuthMode[] = ['local', 'token', 'open'];
export const DEFAULT_AUTH_MODE: LocalAuthMode = 'local';

/**
 * Validate an auth mode string. Unrecognised values are a loud error (never a
 * silent fallback): a typo in an auth setting must not decide which security
 * policy runs.
 */
export function parseAuthMode(value: string, origin: string): LocalAuthMode {
  const normalized = value.trim().toLowerCase();
  if ((AUTH_MODES as readonly string[]).includes(normalized)) {
    return normalized as LocalAuthMode;
  }
  throw new LocalConfigError(
    `Unknown auth mode "${value}" in ${origin}. Expected "local", "token", or "open".`
  );
}

/**
 * Authentication mode, highest precedence first:
 *   1. `NETPRO_AUTH_MODE` environment variable
 *   2. `[auth] mode` in `~/.netpro/config.toml`
 *   3. `local`
 *
 * Lives here rather than in `@netpro/server` because it is a property of the
 * *installation*, not of any one process: the CLI reports it, the server obeys
 * it, and neither has to import the other to find out.
 */
export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): LocalAuthMode {
  const raw = env.NETPRO_AUTH_MODE?.trim().toLowerCase();
  if (raw) return parseAuthMode(raw, 'NETPRO_AUTH_MODE');
  const fromFile = readLocalConfig(env).auth?.mode;
  if (fromFile) return fromFile; // readLocalConfig already validated it
  return DEFAULT_AUTH_MODE;
}

export type LocalConfig = {
  database?: LocalDatabaseConfig;
  /** Validated by readLocalConfig: host is a string, port an integer 1–65535. */
  server?: { host?: string; port?: number; allowedOrigins?: string; webUrl?: string };
  installation?: LocalInstallationConfig;
  auth?: { mode?: LocalAuthMode };
  raw: TomlTable;
};

export class LocalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalConfigError';
  }
}

function expectString(section: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LocalConfigError(`config.toml [${section}] ${key} must be a non-empty string`);
  }
  return value.trim();
}

/** Read and validate `<home>/config.toml`. Missing file → empty config. */
export function readLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const path = configTomlPath(env);
  if (!existsSync(path)) return { raw: {} };

  let parsed: ParsedToml;
  try {
    parsed = parseToml(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof TomlError) {
      throw new LocalConfigError(`${path}: ${error.message}`);
    }
    throw error;
  }

  const { table } = parsed;
  for (const section of Object.keys(table)) {
    if (
      section !== 'database' &&
      section !== 'server' &&
      section !== 'installation' &&
      section !== 'auth'
    ) {
      throw new LocalConfigError(
        `${path}: unknown section [${section}] ` +
          `(NetPro understands [database], [server], [installation], and [auth])`
      );
    }
  }

  const database = table.database;
  if (database !== undefined && typeof database !== 'object') {
    throw new LocalConfigError(`${path}: [database] must be a table`);
  }
  const server = table.server;
  if (server !== undefined && typeof server !== 'object') {
    throw new LocalConfigError(`${path}: [server] must be a table`);
  }
  const installation = table.installation;
  if (installation !== undefined && typeof installation !== 'object') {
    throw new LocalConfigError(`${path}: [installation] must be a table`);
  }
  const auth = table.auth;
  if (auth !== undefined && typeof auth !== 'object') {
    throw new LocalConfigError(`${path}: [auth] must be a table`);
  }

  const dbTable = (database ?? {}) as TomlTable;
  const serverTable = (server ?? {}) as TomlTable;
  const installationTable = (installation ?? {}) as TomlTable;
  const authTable = (auth ?? {}) as TomlTable;

  const config: LocalConfig = { raw: table };
  const dialect = expectString('database', 'dialect', dbTable.dialect);
  const dbPath = expectString('database', 'path', dbTable.path);
  const url = expectString('database', 'url', dbTable.url);
  if (dialect !== undefined || dbPath !== undefined || url !== undefined) {
    config.database = { dialect, path: dbPath, url };
  }
  // Phase 23 — unknown [server] keys are rejected, not ignored: a typo in a
  // security setting must never silently leave the default in force.
  for (const key of Object.keys(serverTable)) {
    if (!['host', 'port', 'allowed_origins', 'web_url'].includes(key)) {
      throw new LocalConfigError(
        `${path}: unknown key "${key}" in [server] ` +
          `(NetPro understands host, port, allowed_origins, web_url)`
      );
    }
  }
  const host = expectString('server', 'host', serverTable.host);
  const port = serverTable.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new LocalConfigError(`${path}: [server] port must be an integer between 1 and 65535`);
  }
  // A comma-separated origin list (the config subset has no arrays):
  // allowed_origins = "https://ui.example.com, https://netpro.example.com".
  // NETPRO_ALLOWED_ORIGINS wins over this when both are set.
  const allowedOrigins = expectString('server', 'allowed_origins', serverTable.allowed_origins);
  // Where the separate Web UI (apps/web) is reachable, when the operator runs
  // one. The server does not serve that UI — it only advertises the address in
  // the `netpro serve` banner — so this is display metadata, not a bind target.
  const webUrl = expectString('server', 'web_url', serverTable.web_url);
  if (
    host !== undefined ||
    port !== undefined ||
    allowedOrigins !== undefined ||
    webUrl !== undefined
  ) {
    config.server = {
      host,
      port: port as number, // validated above
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
      ...(webUrl === undefined ? {} : { webUrl }),
    };
  }

  // ── [installation] — local identity (Phase 5) ──
  //
  // Unknown keys are rejected rather than ignored: silently dropping a typo'd
  // key in an identity block is exactly how an install ends up believing it is
  // configured when it is not.
  for (const key of Object.keys(installationTable)) {
    if (!['id', 'created_at', 'owner', 'email'].includes(key)) {
      throw new LocalConfigError(
        `${path}: unknown key "${key}" in [installation] ` +
          `(NetPro understands id, created_at, owner, email)`
      );
    }
  }
  const installationId = expectString('installation', 'id', installationTable.id);
  if (installationId !== undefined && installationId.length > 200) {
    throw new LocalConfigError(`${path}: [installation] id is too long (max 200 characters)`);
  }
  const createdAt = expectString('installation', 'created_at', installationTable.created_at);
  const owner = expectString('installation', 'owner', installationTable.owner);
  const email = expectString('installation', 'email', installationTable.email);
  if (
    installationId !== undefined ||
    createdAt !== undefined ||
    owner !== undefined ||
    email !== undefined
  ) {
    config.installation = {
      ...(installationId === undefined ? {} : { id: installationId }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(owner === undefined ? {} : { owner }),
      ...(email === undefined ? {} : { email }),
    };
  }

  // ── [auth] — authentication mode (Phase 5) ──
  for (const key of Object.keys(authTable)) {
    if (key !== 'mode') {
      throw new LocalConfigError(
        `${path}: unknown key "${key}" in [auth] (NetPro understands mode)`
      );
    }
  }
  const authMode = expectString('auth', 'mode', authTable.mode);
  if (authMode !== undefined) {
    if (authMode !== 'local' && authMode !== 'token' && authMode !== 'open') {
      throw new LocalConfigError(
        `${path}: [auth] mode must be "local", "token", or "open" (got "${authMode}")`
      );
    }
    config.auth = { mode: authMode };
  }
  return config;
}

// ── Resolved database configuration ──────────────────────────────────────

export type DbDialect = 'sqlite' | 'postgresql';

export type DatabaseConfig = {
  dialect: DbDialect;
  /** SQLite file path (absolute). Set only for the sqlite dialect. */
  path?: string;
  /** PostgreSQL connection string. Set only for the postgresql dialect. */
  url?: string;
  /** Where the dialect decision came from — surfaced by `netpro status`. */
  source: 'env' | 'config' | 'default';
};

const DIALECT_ALIASES: Record<string, DbDialect> = {
  sqlite: 'sqlite',
  postgres: 'postgresql',
  postgresql: 'postgresql',
};

function parseDialect(value: string, origin: string): DbDialect {
  const dialect = DIALECT_ALIASES[value.trim().toLowerCase()];
  if (!dialect) {
    throw new LocalConfigError(
      `Unknown database dialect "${value}" in ${origin}. Expected "sqlite" or "postgresql".`
    );
  }
  return dialect;
}

/**
 * Dialect-only resolution, shared by `resolveDialect()` (@netpro/db) and
 * `resolveDatabaseConfig()`. Tolerant of a missing Postgres connection string.
 */
export function resolveDialectStep(
  env: NodeJS.ProcessEnv = process.env
): { dialect: DbDialect; source: DatabaseConfig['source'] } {
  const file = readLocalConfig(env);
  const envDialect = env.DB_DIALECT?.trim();
  if (envDialect) {
    return { dialect: parseDialect(envDialect, 'DB_DIALECT'), source: 'env' };
  }
  const fileDialect = file.database?.dialect;
  if (typeof fileDialect === 'string') {
    return { dialect: parseDialect(fileDialect, configTomlPath(env)), source: 'config' };
  }
  // Phase 4: no hosted-platform inference. A set DATABASE_URL alone never
  // flips the dialect — SQLite is the local default and PostgreSQL is chosen
  // explicitly (DB_DIALECT or [database] dialect). Deployments that used to
  // rely on the inference set DB_DIALECT=postgresql, which is clearer anyway.
  return { dialect: 'sqlite', source: 'default' };
}

/**
 * Resolve the effective database configuration for this process.
 *
 * Dialect precedence:
 *   1. `DB_DIALECT` environment variable
 *   2. `[database] dialect` in `~/.netpro/config.toml`
 *   3. SQLite (the local-first default)
 *
 * SQLite path precedence: `DB_PATH` env → config `[database] path`
 * (resolved against the install directory, `~/` expanded) → `<home>/netpro.db`.
 *
 * Postgres URL precedence: `DATABASE_URL` env → config `[database] url`;
 * postgres without any URL is a configuration error.
 */
export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const { dialect, source } = resolveDialectStep(env);
  const file = readLocalConfig(env);

  if (dialect === 'sqlite') {
    const envPath = env.DB_PATH?.trim();
    const filePath = typeof file.database?.path === 'string' ? file.database.path : undefined;
    const path = envPath
      ? expandHomePath(envPath, env)
      : filePath
        ? resolveSqlitePath(filePath, env)
        : defaultSqlitePath(env);
    return { dialect, path, source };
  }

  const url = env.DATABASE_URL?.trim() ||
    (typeof file.database?.url === 'string' ? file.database.url.trim() : '');
  if (!url) {
    throw new LocalConfigError(
      'DATABASE_URL is required when the database dialect is "postgresql". ' +
        'Set DATABASE_URL, or add url = "postgresql://…" to [database] in ' +
        configTomlPath(env) +
        '. (For local single-user use, the default SQLite dialect needs no URL at all.)'
    );
  }
  return { dialect, url, source };
}

/**
 * Display form of the database location: SQLite paths are abbreviated with
 * `~` when they live under the home directory; PostgreSQL URLs have their
 * credentials redacted (`postgresql://user:***@host:5432/netpro`).
 */
export function describeDatabaseConfig(config: DatabaseConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.dialect === 'sqlite') {
    const path = config.path ?? defaultSqlitePath(env);
    const home = homedir();
    if (path === home) return '~';
    if (path.startsWith(home + '/')) return `~${path.slice(home.length)}`;
    return path;
  }
  return redactPostgresUrl(config.url ?? '');
}

/** Redact the password (and anything after it) of a PostgreSQL URL for display. */
export function redactPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return 'postgresql://(unparseable connection string)';
  }
}
