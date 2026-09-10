import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServe, isLoopbackHost, friendlyListenError, type ServeHandle } from './serve';

const savedEnv = { ...process.env };
const handles: ServeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) {
    await handles.pop()!.close().catch(() => {});
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  process.env = { ...savedEnv };
});

/**
 * Point the process at a scratch install (isolated home + SQLite file).
 * createDb()/loadConfig() accept env overlays, but the overlay must carry
 * NETPRO_HOME for every call — mutating process.env keeps one source of
 * truth; afterEach restores it.
 */
function scratchEnv(dbName = 'netpro.db'): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-serve-'));
  dirs.push(dir);
  process.env.NETPRO_HOME = dir;
  process.env.DB_PATH = join(dir, dbName);
  return { ...process.env };
}

describe('runServe (netpro serve core)', () => {
  it('starts on an ephemeral port, prints the Phase 2 banner, and serves traffic', async () => {
    const lines: string[] = [];
    const handle = await runServe({
      env: scratchEnv(),
      host: '127.0.0.1',
      port: 0,
      log: (line) => lines.push(line),
      signals: [],
    });
    handles.push(handle);

    // Banner matches the plan's example shape.
    const text = lines.join('\n');
    expect(text).toContain('NetPro server started');
    expect(text).toContain(`Local:    ${handle.url}`);
    expect(text).toContain('Database: ');
    expect(text).toContain(`Web UI:   ${handle.url}`);
    expect(text).not.toContain('⚠');
    // Isolated install: SQLite file under the scratch home, not ~/.netpro.
    expect(text).toMatch(/Database: .*netpro-serve-/);

    const health = await fetch(`${handle.url}/api/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { dialect: string }).dialect).toBe('sqlite');

    const home = await fetch(handle.url);
    expect(home.status).toBe(200);
    expect((await home.text())).toContain('Net');

    // Graceful close resolves `stopped` and releases everything.
    await handle.close();
    await expect(handle.stopped).resolves.toEqual({ reason: 'close' });
  });

  it('binds loopback by default from config defaults', async () => {
    const handle = await runServe({ env: scratchEnv(), port: 0, signals: [] });
    handles.push(handle);
    expect(handle.host).toBe('127.0.0.1');
  });

  it('warns when bound to a non-loopback address', async () => {
    const lines: string[] = [];
    const handle = await runServe({
      env: scratchEnv(),
      host: '0.0.0.0',
      port: 0,
      log: (line) => lines.push(line),
      signals: [],
    });
    handles.push(handle);
    const text = lines.join('\n');
    expect(text).toMatch(/⚠ Bound to 0\.0\.0\.0/);
    expect(text).toMatch(/local-first default is 127\.0\.0\.1/i);
    // Wildcard binds advertise the browsable loopback URL, not 0.0.0.0 itself.
    expect(text).toContain(`Local:    http://127.0.0.1:${handle.port}`);
  });

  it('turns EADDRINUSE into an actionable error', async () => {
    const first = await runServe({ env: scratchEnv(), host: '127.0.0.1', port: 0, signals: [] });
    handles.push(first);

    const second = await runServe({
      env: scratchEnv(),
      host: '127.0.0.1',
      port: first.port,
      signals: [],
    }).catch((error: unknown) => error as Error);
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/already in use/);
    expect((second as Error).message).toMatch(/--port/);
  });

  it('propagates config.toml database errors instead of starting half-broken', async () => {
    const env = scratchEnv();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(env.NETPRO_HOME!, 'config.toml'), '[database]\ndialect = "postgresql"\n');
    await expect(runServe({ env, port: 0, signals: [] })).rejects.toThrow(/DATABASE_URL is required/);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.9.9.9', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    }
  );

  it.each(['0.0.0.0', '::', '', '192.168.1.10', 'example.com'])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('friendlyListenError', () => {
  it('maps EACCES to a port hint', () => {
    expect(friendlyListenError({ code: 'EACCES' }, '127.0.0.1', 80).message).toMatch(/above 1024/);
  });

  it('maps EADDRNOTAVAIL to a host hint', () => {
    expect(friendlyListenError({ code: 'EADDRNOTAVAIL' }, '10.255.255.1', 3777).message).toMatch(
      /does not exist on this machine/
    );
  });

  it('passes unknown errors through', () => {
    const original = new Error('mystery');
    expect(friendlyListenError(original, '127.0.0.1', 3777)).toBe(original);
  });
});
