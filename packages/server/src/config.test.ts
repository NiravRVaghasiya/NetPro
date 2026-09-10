import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  loadConfig,
} from './config';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

function homeWithConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-server-cfg-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), body);
  process.env.NETPRO_HOME = dir;
  return dir;
}

describe('loadConfig', () => {
  it('defaults to loopback on port 3777', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      autoMigrate: true,
      auth: { mode: 'local' },
    });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3777);
  });

  it('reads NETPRO_HOST and NETPRO_PORT', () => {
    const cfg = loadConfig({
      NETPRO_HOST: '127.0.0.1',
      NETPRO_PORT: '4000',
    });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(4000);
  });

  it('falls back on invalid port values', () => {
    expect(loadConfig({ NETPRO_PORT: 'nope' }).port).toBe(3777);
    expect(loadConfig({ NETPRO_PORT: '0' }).port).toBe(3777);
    expect(loadConfig({ NETPRO_PORT: '99999' }).port).toBe(3777);
  });

  it('honours NETPRO_AUTO_MIGRATE off values', () => {
    expect(loadConfig({ NETPRO_AUTO_MIGRATE: 'false' }).autoMigrate).toBe(false);
    expect(loadConfig({ NETPRO_AUTO_MIGRATE: '0' }).autoMigrate).toBe(false);
    expect(loadConfig({ NETPRO_AUTO_MIGRATE: 'off' }).autoMigrate).toBe(false);
    expect(loadConfig({ NETPRO_AUTO_MIGRATE: 'true' }).autoMigrate).toBe(true);
  });

  it('never defaults host to 0.0.0.0', () => {
    // Empty env must stay local-only; remote bind is opt-in only.
    expect(loadConfig({}).host).not.toBe('0.0.0.0');
  });
});

describe('loadConfig with ~/.netpro/config.toml', () => {
  it('reads [server] host and port from the config file', () => {
    homeWithConfig('[server]\nhost = "127.0.0.1"\nport = 4001\n');
    expect(loadConfig()).toEqual({
      host: '127.0.0.1',
      port: 4001,
      autoMigrate: true,
      auth: { mode: 'local' },
    });
  });

  it('reads [auth] mode from the config file (phase 5)', () => {
    homeWithConfig('[auth]\nmode = "token"\n');
    expect(loadConfig().auth).toEqual({ mode: 'token' });
  });

  it('lets NETPRO_AUTH_MODE override the config file (phase 5)', () => {
    homeWithConfig('[auth]\nmode = "token"\n');
    expect(loadConfig({ NETPRO_AUTH_MODE: 'open' }).auth).toEqual({ mode: 'open' });
  });

  it('rejects an unknown auth mode instead of silently choosing a policy (phase 5)', () => {
    expect(() => loadConfig({ NETPRO_AUTH_MODE: 'public' })).toThrow(/Unknown auth mode/);
    const home = homeWithConfig('[auth]\nmode = "nope"\n');
    expect(() => loadConfig()).toThrow(/\[auth\] mode must be/);
    rmSync(home, { recursive: true, force: true });
  });

  it('environment variables override the config file', () => {
    homeWithConfig('[server]\nhost = "0.0.0.0"\nport = 4001\n');
    expect(loadConfig({ NETPRO_HOST: '127.0.0.1', NETPRO_PORT: '5000' })).toEqual({
      host: '127.0.0.1',
      port: 5000,
      autoMigrate: true,
      auth: { mode: 'local' },
    });
  });

  it('missing config file falls back to defaults', () => {
    process.env.NETPRO_HOME = mkdtempSync(join(tmpdir(), 'netpro-server-cfg-'));
    expect(loadConfig()).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      autoMigrate: true,
      auth: { mode: 'local' },
    });
  });

  it('falls back per-key, not per-file', () => {
    // Host from file, port from env — overrides are per setting.
    homeWithConfig('[server]\nhost = "127.0.0.1"\nport = 4001\n');
    expect(loadConfig({ NETPRO_PORT: '5000' })).toEqual({
      host: '127.0.0.1',
      port: 5000,
      autoMigrate: true,
      auth: { mode: 'local' },
    });
  });

  it('rejects an invalid config file loudly instead of stranding defaults', () => {
    const home = homeWithConfig('[server]\nport = 99999\n');
    expect(() => loadConfig()).toThrow(/port must be an integer/);
    rmSync(home, { recursive: true, force: true });
  });

  it('a non-numeric env port falls back to the file port, not the built-in default', () => {
    // positivePort guards each source independently: garbage in NETPRO_PORT
    // means "no env setting", so the file value (4001) applies — never 3777.
    const home = homeWithConfig('[server]\nport = 4001\n');
    expect(loadConfig({ NETPRO_HOME: home, NETPRO_PORT: 'nope' }).port).toBe(4001);
    rmSync(home, { recursive: true, force: true });
  });
});
