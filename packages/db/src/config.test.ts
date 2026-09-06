import { afterEach, describe, expect, it } from 'vitest';
import { autoMigrateEnabled } from './migrate';
import { createDb, resolvePgSsl, resolvePoolConfig } from './index';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('resolvePgSsl', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('encrypts without verification for provider sslmode=require URLs', () => {
    // Supabase/Neon hand out exactly this and sign with their own CA, so
    // strict verification fails with SELF_SIGNED_CERT_IN_CHAIN.
    expect(
      resolvePgSsl('postgresql://u:p@db.supabase.co:5432/postgres?sslmode=require', env)
    ).toEqual({ rejectUnauthorized: false });
  });

  it('verifies the certificate for sslmode=verify-full', () => {
    expect(
      resolvePgSsl('postgresql://u:p@host:5432/db?sslmode=verify-full', env)
    ).toEqual({ rejectUnauthorized: true });
  });

  it('disables TLS entirely for sslmode=disable', () => {
    // A compose Postgres on a private network has no TLS; forcing it fails
    // with "server does not support SSL connections".
    expect(resolvePgSsl('postgresql://netpro@db:5432/netpro?sslmode=disable', env)).toBe(
      false
    );
  });

  it('leaves TLS to pg when no mode is specified', () => {
    expect(resolvePgSsl('postgresql://netpro@localhost:5432/netpro', env)).toBeUndefined();
  });

  it('verifies against an explicitly supplied CA, overriding a lax sslmode', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----';
    expect(
      resolvePgSsl('postgresql://u:p@host:5432/db?sslmode=require', {
        NETPRO_DB_SSL_CA: ca,
      } as NodeJS.ProcessEnv)
    ).toEqual({ ca, rejectUnauthorized: true });
  });

  it('falls back to PGSSLMODE for non-URL DSNs instead of throwing', () => {
    expect(
      resolvePgSsl('host=db user=netpro dbname=netpro', {
        PGSSLMODE: 'require',
      } as NodeJS.ProcessEnv)
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe('resolvePoolConfig', () => {
  it('keeps one connection per serverless instance', () => {
    // Instances scale out horizontally; a big per-instance pool multiplies
    // into connection exhaustion on the managed database.
    expect(resolvePoolConfig({ VERCEL: '1' } as NodeJS.ProcessEnv).max).toBe(1);
  });

  it('uses a roomier pool for long-lived servers', () => {
    expect(resolvePoolConfig({} as NodeJS.ProcessEnv).max).toBe(10);
  });

  it('lets an operator override the pool size', () => {
    expect(
      resolvePoolConfig({ VERCEL: '1', NETPRO_DB_POOL_MAX: '5' } as NodeJS.ProcessEnv).max
    ).toBe(5);
  });

  it('ignores nonsense overrides rather than creating a broken pool', () => {
    expect(
      resolvePoolConfig({ NETPRO_DB_POOL_MAX: 'lots' } as NodeJS.ProcessEnv).max
    ).toBe(10);
    expect(resolvePoolConfig({ NETPRO_DB_POOL_MAX: '0' } as NodeJS.ProcessEnv).max).toBe(
      10
    );
  });
});

describe('autoMigrateEnabled', () => {
  it('defaults to on so the CLI and Docker keep migrating on startup', () => {
    expect(autoMigrateEnabled(undefined)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' false '])(
    'treats %j as disabled',
    (value) => {
      expect(autoMigrateEnabled(value)).toBe(false);
    }
  );

  it.each(['true', '1', 'yes'])('treats %j as enabled', (value) => {
    expect(autoMigrateEnabled(value)).toBe(true);
  });
});

describe('createDb guard rails', () => {
  it('refuses ephemeral SQLite on Vercel', () => {
    // Vercel's filesystem is per-instance and wiped on redeploy, so a SQLite
    // database there silently loses the user's imported network. Fail loudly
    // at startup instead of shipping a deploy that looks fine.
    process.env.VERCEL = '1';
    process.env.DB_DIALECT = 'sqlite';
    expect(() => createDb()).toThrow(/ephemeral/i);
    expect(() => createDb()).toThrow(/DB_DIALECT=postgresql/);
  });

  it('allows an explicit opt-out for throwaway preview deploys', () => {
    process.env.VERCEL = '1';
    process.env.DB_DIALECT = 'sqlite';
    process.env.NETPRO_ALLOW_EPHEMERAL_SQLITE = '1';
    process.env.DB_PATH = ':memory:';
    expect(() => createDb()).not.toThrow();
  });

  it('still requires DATABASE_URL for the postgres dialect', () => {
    process.env.DB_DIALECT = 'postgresql';
    delete process.env.DATABASE_URL;
    expect(() => createDb()).toThrow(/DATABASE_URL is required/);
  });

  it('rejects an unknown dialect instead of silently defaulting', () => {
    process.env.DB_DIALECT = 'mysql';
    expect(() => createDb()).toThrow(/Unknown DB_DIALECT/);
  });
});
