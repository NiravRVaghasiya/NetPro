import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    const written = readFileSync(join(home, 'config.toml'), 'utf8');
    // Every hand-written line survives, in order; init only fills in the
    // identity keys it must (Phase 5) — it never rewrites the user's file.
    const withoutInsertedKeys = written
      .split('\n')
      .filter((line) => !/^id = |^created_at = /.test(line))
      .join('\n');
    expect(withoutInsertedKeys).toBe(custom);
    expect(first.applied).toBe(first.total);

    // Second run: identity and token are reused, not regenerated.
    const second = await executeInit();
    expect(second.installationCreated).toBe(false);
    expect(second.tokenCreated).toBe(false);
    expect(second.installation.id).toBe(first.installation.id);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(written);

    const { closeConn } = await import('@netpro/db');
    await closeConn(first.conn);
    await closeConn(second.conn);
  });

  it('mints the installation identity and a 0600 access token (Phase 5)', async () => {
    const home = scratchHome();
    const first = await executeInit(process.env, { owner: 'Alex' });

    expect(first.installationCreated).toBe(true);
    expect(first.installation.id).toMatch(/^ins_[0-9a-f]{24}$/);
    expect(first.installation.owner).toBe('Alex');
    expect(first.tokenCreated).toBe(true);
    expect(first.tokenPath).toBe(join(home, 'keys', 'access-token'));
    // The printed value is a redacted preview, never the token itself.
    expect(first.tokenPreview).toMatch(/^np_.*…/);

    const { readAccessToken, readInstallationIdentity } = await import('@netpro/db');
    const onDisk = readAccessToken(process.env);
    expect(onDisk).toMatch(/^np_/);
    expect(first.tokenPreview).not.toBe(onDisk);
    expect((await import('node:fs')).statSync(first.tokenPath).mode & 0o777).toBe(0o600);

    const identity = readInstallationIdentity(process.env);
    expect(identity?.id).toBe(first.installation.id);
    expect(identity?.owner).toBe('Alex');
    expect(identity?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const { closeConn } = await import('@netpro/db');
    await closeConn(first.conn);
  });

  it('keeps a hand-written identity instead of overwriting it (Phase 5)', async () => {
    const home = scratchHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.toml'),
      '[installation]\nid = "ins_manual"\ncreated_at = "2020-01-01T00:00:00.000Z"\nowner = "Me"\n'
    );

    const result = await executeInit();
    expect(result.installationCreated).toBe(false);
    expect(result.installation.id).toBe('ins_manual');
    expect(result.installation.owner).toBe('Me');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('ins_manual');

    const { closeConn } = await import('@netpro/db');
    await closeConn(result.conn);
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
