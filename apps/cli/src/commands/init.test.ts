import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigToml, executeInit, initFailureHint } from './init';

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-init-'));
  process.env.NETPRO_HOME = dir;
  return dir;
}

describe('netpro init (local-first Phase 3 exit criteria)', () => {
  it('creates ~/.netpro with config.toml, logs/, keys/, and a migrated SQLite DB — no Postgres, no DATABASE_URL', async () => {
    const home = scratchHome();
    const result = await executeInit();

    expect(result.home).toBe(home);
    expect(existsSync(join(home, 'config.toml'))).toBe(true);
    expect(existsSync(result.logs)).toBe(true);
    expect(existsSync(result.keys)).toBe(true);
    expect(result.configCreated).toBe(true);

    // SQLite is the default dialect and the file is real + migrated.
    expect(result.dialect).toBe('sqlite');
    expect(result.databaseDisplay).toBe(join(home, 'netpro.db'));
    expect(existsSync(join(home, 'netpro.db'))).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.applied).toBe(result.total);

    // The migrated schema is actually there.
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(join(home, 'netpro.db'), { readonly: true });
    try {
      expect(probe.prepare('SELECT count(*) AS n FROM contacts').get()).toEqual({ n: 0 });
    } finally {
      probe.close();
    }

    const { closeConn } = await import('@netpro/db');
    await closeConn(result.conn);
  });

  it('is idempotent: never overwrites an existing config.toml, re-runs are no-ops', async () => {
    const home = scratchHome();
    const custom = defaultConfigToml() + '\n# my precious hand edit\n';
    writeFileSync(join(home, 'config.toml'), custom);

    const first = await executeInit();
    expect(first.configCreated).toBe(false);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(custom);
    expect(first.applied).toBe(first.total);

    const { closeConn } = await import('@netpro/db');
    await closeConn(first.conn);
  });

  it('a failed init against a broken config does not leave the error cryptic', async () => {
    const home = scratchHome();
    writeFileSync(join(home, 'config.toml'), '[database]\ndialect = "postgresql"\n');

    await expect(executeInit()).rejects.toThrow(/DATABASE_URL is required/);
    // The actionable hint covers exactly this class of misconfiguration.
    expect(initFailureHint('DATABASE_URL is required when the database dialect is "postgresql".')).toMatch(
      /keep the default sqlite dialect/
    );
    // Directory structure still exists (init got far enough to create it).
    expect(existsSync(join(home, 'logs'))).toBe(true);
  });

  it('writes a config.toml that parses back to the documented defaults', async () => {
    const home = scratchHome();
    const { readLocalConfig, resolveDatabaseConfig } = await import('@netpro/db/src/local');
    await executeInit();

    const config = readLocalConfig();
    expect(config.database).toBeUndefined(); // every database line is commented out
    expect(resolveDatabaseConfig()).toEqual({
      dialect: 'sqlite',
      path: join(home, 'netpro.db'),
      source: 'default',
    });
  });
});
