import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configTomlPath,
  defaultSqlitePath,
  describeDatabaseConfig,
  ensureNetProHome,
  ensureSqliteDir,
  expandHomePath,
  LocalConfigError,
  netproHome,
  parseToml,
  readLocalConfig,
  redactPostgresUrl,
  resolveDatabaseConfig,
  resolveSqlitePath,
} from './local';

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

/** Point NETPRO_HOME at a scratch directory that cleans up after itself. */
function scratchHome(prefix = 'netpro-local-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.NETPRO_HOME = dir;
  return dir;
}

function writeConfig(home: string, body: string): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'config.toml');
  writeFileSync(path, body);
  return path;
}

describe('netproHome', () => {
  it('defaults to ~/.netpro', () => {
    expect(netproHome({})).toBe(join(homedir(), '.netpro'));
  });

  it('honours NETPRO_HOME', () => {
    expect(netproHome({ NETPRO_HOME: '/tmp/alt-home' })).toBe('/tmp/alt-home');
  });

  it('expands ~ in NETPRO_HOME', () => {
    expect(netproHome({ NETPRO_HOME: '~/netpro-test' })).toBe(join(homedir(), 'netpro-test'));
  });

  it('ignores a blank NETPRO_HOME', () => {
    expect(netproHome({ NETPRO_HOME: '   ' })).toBe(join(homedir(), '.netpro'));
  });

  it('config file and default db live inside the home', () => {
    const env = { NETPRO_HOME: '/tmp/h' } as NodeJS.ProcessEnv;
    expect(configTomlPath(env)).toBe('/tmp/h/config.toml');
    expect(defaultSqlitePath(env)).toBe('/tmp/h/netpro.db');
  });
});

describe('expandHomePath / resolveSqlitePath', () => {
  it('expands a leading ~/', () => {
    expect(expandHomePath('~/data/netpro.db', {})).toBe(join(homedir(), 'data/netpro.db'));
    expect(expandHomePath('~', {})).toBe(homedir());
  });

  it('leaves absolute and relative paths alone', () => {
    expect(expandHomePath('/var/lib/netpro.db', {})).toBe('/var/lib/netpro.db');
    expect(expandHomePath('netpro.db', {})).toBe('netpro.db');
  });

  it('resolves relative config paths against the install dir, not the cwd', () => {
    const env = { NETPRO_HOME: '/tmp/h' } as NodeJS.ProcessEnv;
    expect(resolveSqlitePath('netpro.db', env)).toBe('/tmp/h/netpro.db');
    expect(resolveSqlitePath('./db/x.db', env)).toBe('/tmp/h/db/x.db');
    expect(resolveSqlitePath('~/elsewhere.db', env)).toBe(join(homedir(), 'elsewhere.db'));
    expect(resolveSqlitePath('/abs/x.db', env)).toBe('/abs/x.db');
  });
});

describe('ensureNetProHome', () => {
  it('creates the home, logs, and keys directories and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-home-'));
    process.env.NETPRO_HOME = join(dir, 'nested', 'home'); // parents created too
    try {
      const first = ensureNetProHome();
      const second = ensureNetProHome();
      expect(first.home).toBe(process.env.NETPRO_HOME);
      expect(second.logs).toBe(join(first.home, 'logs'));
      expect(second.keys).toBe(join(first.home, 'keys'));
      for (const p of [first.home, first.logs, first.keys]) {
        expect(existsSync(p)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores the install directory mode 0700 and tightens pre-existing installs (phase 23)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-home-'));
    process.env.NETPRO_HOME = join(dir, 'home');
    try {
      const layout = ensureNetProHome();
      for (const p of [layout.home, layout.logs, layout.keys]) {
        expect(statSync(p).mode & 0o777).toBe(0o700);
      }
      // A pre-hardening install (world-readable) tightens on next touch.
      chmodSync(layout.home, 0o755);
      chmodSync(layout.keys, 0o755);
      ensureNetProHome();
      expect(statSync(layout.home).mode & 0o777).toBe(0o700);
      expect(statSync(layout.keys).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureSqliteDir', () => {
  it('creates the parent directory of a sqlite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-sqlite-'));
    try {
      ensureSqliteDir(join(dir, 'a', 'b', 'netpro.db'));
      expect(existsSync(join(dir, 'a', 'b'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores :memory:', () => {
    expect(() => ensureSqliteDir(':memory:')).not.toThrow();
  });
});

describe('parseToml', () => {
  it('parses the plan’s [database] example', () => {
    const { table } = parseToml(`
[database]
dialect = "sqlite"
path = "~/.netpro/netpro.db"
`);
    expect(table.database).toEqual({ dialect: 'sqlite', path: '~/.netpro/netpro.db' });
  });

  it('parses the postgres example with a url', () => {
    const { table } = parseToml(`
[database]
dialect = "postgresql"
url = "postgresql://netpro:secret@db.internal:5432/netpro"
`);
    expect(table.database).toEqual({
      dialect: 'postgresql',
      url: 'postgresql://netpro:secret@db.internal:5432/netpro',
    });
  });

  it('supports integers, floats, booleans, literal strings, and comments', () => {
    const { table } = parseToml(`
# top comment
[server]   # trailing comment after header
host = "127.0.0.1"
port = 3777
ratio = 0.75
verbose = true
name = 'literal # not a comment'
`);
    expect(table.server).toEqual({
      host: '127.0.0.1',
      port: 3777,
      ratio: 0.75,
      verbose: true,
      name: 'literal # not a comment',
    });
  });

  it('handles basic string escapes', () => {
    const { table } = parseToml('a = "line\\nbreak\\ttab \\" quoted \\\\ \u00e9"');
    expect(table.a).toBe('line\nbreak\ttab " quoted \\ \u00e9');
  });

  it('reports line numbers on syntax errors', () => {
    expect(() => parseToml('ok = 1\nwhat is this')).toThrow(/line 2/);
    expect(() => parseToml('a = "unterminated')).toThrow(/line 1/);
    expect(() => parseToml('[dup]\nx = 1\n[dup]\ny = 2')).toThrow(/more than once/);
    expect(() => parseToml('a = 1\na = 2')).toThrow(/duplicate key/);
    expect(() => parseToml('a = [1, 2]')).toThrow(/arrays/);
    expect(() => parseToml('a = { b = 1 }')).toThrow(/inline tables/);
    expect(() => parseToml('a.b = 1')).toThrow(/invalid key/);
    // Bare words are not valid values — config strings must be quoted.
    expect(() => parseToml('[database]\ndialect = sqlite')).toThrow(/unsupported value "sqlite"/);
  });
});

describe('readLocalConfig', () => {
  it('returns an empty config when the file is missing', () => {
    scratchHome();
    expect(readLocalConfig()).toEqual({ raw: {} });
  });

  it('reads [database] and [server] sections', () => {
    const home = scratchHome();
    writeConfig(
      home,
      `[database]
dialect = "sqlite"
path = "custom.db"

[server]
host = "127.0.0.1"
port = 4000
`
    );
    const config = readLocalConfig();
    expect(config.database).toEqual({ dialect: 'sqlite', path: 'custom.db', url: undefined });
    expect(config.server).toEqual({ host: '127.0.0.1', port: 4000 });
  });

  it('rejects unknown sections naming the offending file', () => {
    const home = scratchHome();
    const path = writeConfig(home, '[widgets]\nsize = 3\n');
    expect(() => readLocalConfig()).toThrow(/unknown section \[widgets\]/);
    expect(() => readLocalConfig()).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('rejects wrong value types and out-of-range ports', () => {
    const home = scratchHome();
    writeConfig(home, '[server]\nport = 70000\n');
    expect(() => readLocalConfig()).toThrow(/port must be an integer/);

    writeConfig(home, '[database]\npath = 123\n');
    expect(() => readLocalConfig()).toThrow(/must be a non-empty string/);
  });

  it('reads [installation] and [auth] sections (phase 5)', () => {
    const home = scratchHome();
    writeConfig(
      home,
      `[installation]
id = "ins_9f2c"
created_at = "2026-09-10T12:00:00.000Z"
owner = "Alex"
email = "alex@example.com"

[auth]
mode = "token"
`
    );
    const config = readLocalConfig();
    expect(config.installation).toEqual({
      id: 'ins_9f2c',
      createdAt: '2026-09-10T12:00:00.000Z',
      owner: 'Alex',
      email: 'alex@example.com',
    });
    expect(config.auth).toEqual({ mode: 'token' });
  });

  it('rejects unknown keys and bad values in the new sections (phase 5)', () => {
    const home = scratchHome();
    writeConfig(home, '[auth]\nmode = "public"\n');
    expect(() => readLocalConfig()).toThrow(/\[auth\] mode must be/);

    writeConfig(home, '[auth]\ntoken = "np_sneaky"\n');
    expect(() => readLocalConfig()).toThrow(/unknown key "token" in \[auth\]/);

    writeConfig(home, '[installation]\nident = "ins_typo"\n');
    expect(() => readLocalConfig()).toThrow(/unknown key "ident" in \[installation\]/);

    writeConfig(home, '[installation]\nid = ""\n');
    expect(() => readLocalConfig()).toThrow(/must be a non-empty string/);

    writeConfig(home, '[installation]\nid = 5\n');
    expect(() => readLocalConfig()).toThrow(/must be a non-empty string/);
  });

  it('reads [server] allowed_origins and rejects unknown server keys (phase 23)', () => {
    const home = scratchHome();
    writeConfig(
      home,
      '[server]\nallowed_origins = "https://ui.example.com, https://netpro.example.com"\n'
    );
    expect(readLocalConfig().server).toEqual({
      host: undefined,
      port: undefined,
      allowedOrigins: 'https://ui.example.com, https://netpro.example.com',
    });

    writeConfig(home, '[server]\nallowed_origins = 42\n');
    expect(() => readLocalConfig()).toThrow(/must be a non-empty string/);

    writeConfig(home, '[server]\nallow_origin = "https://typo.example.com"\n');
    expect(() => readLocalConfig()).toThrow(/unknown key "allow_origin" in \[server\]/);
  });

  it('surfaces TOML syntax errors with the file path and line number', () => {
    const home = scratchHome();
    const path = writeConfig(home, 'broken syntax here\n');
    expect(() => readLocalConfig()).toThrow(
      new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*line 1`)
    );
  });
});

describe('resolveDatabaseConfig', () => {
  it('defaults to sqlite at <home>/netpro.db with zero configuration', () => {
    const home = scratchHome();
    expect(resolveDatabaseConfig()).toEqual({
      dialect: 'sqlite',
      path: join(home, 'netpro.db'),
      source: 'default',
    });
  });

  it('does not require DATABASE_URL for local sqlite — even if one is set', () => {
    const home = scratchHome();
    process.env.DATABASE_URL = 'postgresql://leftover@localhost/x';
    const config = resolveDatabaseConfig();
    expect(config.dialect).toBe('sqlite');
    expect(config.url).toBeUndefined();
    expect(config.path).toBe(join(home, 'netpro.db'));
  });

  it('prefers DB_DIALECT over the config file', () => {
    const home = scratchHome();
    writeConfig(home, '[database]\ndialect = "postgresql"\nurl = "postgresql://from@config/x"\n');
    process.env.DB_DIALECT = 'sqlite';
    process.env.DB_PATH = '/tmp/from-env.db';
    expect(resolveDatabaseConfig()).toEqual({
      dialect: 'sqlite',
      path: '/tmp/from-env.db',
      source: 'env',
    });
  });

  it('reads dialect and path from config.toml, resolving ~ and relative paths', () => {
    const home = scratchHome();
    writeConfig(home, '[database]\ndialect = "sqlite"\npath = "~/netpro-elsewhere.db"\n');
    expect(resolveDatabaseConfig()).toEqual({
      dialect: 'sqlite',
      path: join(homedir(), 'netpro-elsewhere.db'),
      source: 'config',
    });

    writeConfig(home, '[database]\ndialect = "sqlite"\npath = "data/x.db"\n');
    expect(resolveDatabaseConfig().path).toBe(join(home, 'data', 'x.db'));
  });

  it('DB_PATH env still wins over a config path for sqlite', () => {
    const home = scratchHome();
    writeConfig(home, '[database]\npath = "from-config.db"\n');
    process.env.DB_PATH = '/tmp/from-env.db';
    expect(resolveDatabaseConfig().path).toBe('/tmp/from-env.db');
  });

  it('uses config.toml for postgresql with a url', () => {
    scratchHome();
    writeConfig(
      process.env.NETPRO_HOME!,
      '[database]\ndialect = "postgresql"\nurl = "postgresql://u:p@db:5432/n"\n'
    );
    const config = resolveDatabaseConfig();
    expect(config.dialect).toBe('postgresql');
    expect(config.url).toBe('postgresql://u:p@db:5432/n');
    expect(config.source).toBe('config');
    expect(config.path).toBeUndefined();
  });

  it('lets DATABASE_URL override the config url while config still picks the dialect', () => {
    const home = scratchHome();
    writeConfig(home, '[database]\ndialect = "postgresql"\nurl = "postgresql://from@config/x"\n');
    process.env.DATABASE_URL = 'postgresql://from@env/x';
    expect(resolveDatabaseConfig().url).toBe('postgresql://from@env/x');
  });

  it('fails loudly when postgres is selected without any connection string', () => {
    const home = scratchHome();
    writeConfig(home, '[database]\ndialect = "postgresql"\n');
    expect(() => resolveDatabaseConfig()).toThrow(LocalConfigError);
    expect(() => resolveDatabaseConfig()).toThrow(/DATABASE_URL/);
  });

  it('never infers postgresql from DATABASE_URL alone (phase 4)', () => {
    // A set DATABASE_URL used to flip the dialect when a hosting-platform
    // marker was present. Now the dialect is what the user configured, and
    // nothing else: local use stays on SQLite even when an unrelated
    // DATABASE_URL and an arbitrary foreign platform marker are exported.
    scratchHome();
    process.env.SOME_CLOUD_PLATFORM = '1';
    process.env.DATABASE_URL = 'postgresql://v@example/x';
    const config = resolveDatabaseConfig();
    expect(config.dialect).toBe('sqlite');
    expect(config.source).toBe('default');
    expect(config.path).toBe(join(process.env.NETPRO_HOME!, 'netpro.db'));
  });

  it('rejects unknown dialects from env and config', () => {
    scratchHome();
    process.env.DB_DIALECT = 'mysql';
    expect(() => resolveDatabaseConfig()).toThrow(/Unknown database dialect "mysql"/);
    delete process.env.DB_DIALECT;
    writeConfig(process.env.NETPRO_HOME!, '[database]\ndialect = "mongo"\n');
    expect(() => resolveDatabaseConfig()).toThrow(/Unknown database dialect "mongo"/);
  });

  it('accepts "postgres" as an alias for "postgresql"', () => {
    scratchHome();
    process.env.DB_DIALECT = 'postgres';
    process.env.DATABASE_URL = 'postgresql://u:p@db/x';
    expect(resolveDatabaseConfig().dialect).toBe('postgresql');
  });
});

describe('describeDatabaseConfig / redactPostgresUrl', () => {
  it('abbreviates sqlite paths under the home directory with ~', () => {
    const underHome = join(homedir(), 'netpro-display-test', 'netpro.db');
    expect(describeDatabaseConfig({ dialect: 'sqlite', path: underHome, source: 'default' })).toBe(
      join('~', 'netpro-display-test', 'netpro.db')
    );
  });

  it('leaves paths outside the home untouched', () => {
    expect(describeDatabaseConfig({ dialect: 'sqlite', path: '/var/lib/netpro.db', source: 'env' })).toBe(
      '/var/lib/netpro.db'
    );
  });

  it('redacts postgres credentials for display', () => {
    expect(redactPostgresUrl('postgresql://user:hunter2@db.example.com:5432/netpro')).toBe(
      'postgresql://user:***@db.example.com:5432/netpro'
    );
    expect(redactPostgresUrl('postgresql://db.example.com:5432/netpro')).toBe(
      'postgresql://db.example.com:5432/netpro'
    );
    expect(redactPostgresUrl('not a url')).toBe('postgresql://(unparseable connection string)');
  });
});
