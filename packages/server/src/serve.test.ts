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
    // Phase 5: the banner names the auth mode, and a loopback start must NOT
    // mint a credential the user did not ask for.
    expect(text).toContain('Auth:     local — loopback trusted');
    expect(text).toContain('Identity: not initialized');
    expect(text).not.toContain('Created an access token');

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
    const env = scratchEnv();
    const lines: string[] = [];
    const handle = await runServe({
      env,
      host: '0.0.0.0',
      port: 0,
      log: (line) => lines.push(line),
      signals: [],
    });
    handles.push(handle);
    const text = lines.join('\n');
    expect(text).toMatch(/⚠ Binding 0\.0\.0\.0/);
    expect(text).toMatch(/reachable from your network/i);
    // Wildcard binds advertise the browsable loopback URL, not 0.0.0.0 itself.
    expect(text).toContain(`Local:    http://127.0.0.1:${handle.port}`);

    // Phase 5: a remote bind is never accidentally unprotected — NetPro mints
    // a token rather than denying every remote caller, and never prints it in
    // full.
    expect(text).toMatch(/Created an access token for remote callers: np_[^\s]*…/);
    const { readAccessToken } = await import('@netpro/db');
    const token = readAccessToken(env);
    expect(token).toMatch(/^np_/);
    expect(text).not.toContain(token!);

    // The minted token works for a caller arriving "remotely".
    const identity = await fetch(`${handle.url}/api/identity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(identity.status).toBe(200);
  });

  it('refuses to start in token mode with no token to require (phase 5)', async () => {
    await expect(
      runServe({
        env: { ...scratchEnv(), NETPRO_AUTH_MODE: 'token' },
        host: '127.0.0.1',
        port: 0,
        signals: [],
      })
    ).rejects.toThrow(/requires an access token/);
  });

  it('rejects an unknown auth mode loudly (phase 5)', async () => {
    await expect(
      runServe({ env: { ...scratchEnv(), NETPRO_AUTH_MODE: 'whatever' }, port: 0, signals: [] })
    ).rejects.toThrow(/Unknown auth mode/);
  });

  it('names the exposure policy on a remote bind, stays quiet on loopback (phase 23)', async () => {
    const remote: string[] = [];
    const remoteHandle = await runServe({
      env: { ...scratchEnv(), NETPRO_AUTH_MODE: 'open' },
      host: '0.0.0.0',
      port: 0,
      log: (line) => remote.push(line),
      signals: [],
    });
    handles.push(remoteHandle);
    const text = remote.join('\n');
    expect(text).toMatch(/Remote bind \(0\.0\.0\.0\): browser origins: loopback origins only/);
    expect(text).toMatch(/rate limit: 600 req\/60s per IP/);
    expect(text).toContain('No TLS here — terminate HTTPS at a reverse proxy');
    expect(text).toContain('docs/deployment.md');

    // Explicit knobs show up verbatim.
    const custom: string[] = [];
    const customHandle = await runServe({
      env: {
        ...scratchEnv(),
        NETPRO_AUTH_MODE: 'open',
        NETPRO_ALLOWED_ORIGINS: 'https://ui.example.com',
        NETPRO_HSTS: 'true',
      },
      host: '0.0.0.0',
      port: 0,
      log: (line) => custom.push(line),
      signals: [],
    });
    handles.push(customHandle);
    const customText = custom.join('\n');
    expect(customText).toContain('browser origins: https://ui.example.com');
    expect(customText).toContain('HSTS: on');
    expect(customText).not.toContain('No TLS here');
  });

  it('warns that open mode answers anyone (phase 5)', async () => {
    const lines: string[] = [];
    const handle = await runServe({
      env: { ...scratchEnv(), NETPRO_AUTH_MODE: 'open' },
      host: '0.0.0.0',
      port: 0,
      log: (line) => lines.push(line),
      signals: [],
    });
    handles.push(handle);
    expect(lines.join('\n')).toMatch(/answers anyone who can reach it/);
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
