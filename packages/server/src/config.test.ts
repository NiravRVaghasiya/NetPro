import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  loadConfig,
} from './config';

describe('loadConfig', () => {
  it('defaults to loopback on port 3777', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      autoMigrate: true,
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
