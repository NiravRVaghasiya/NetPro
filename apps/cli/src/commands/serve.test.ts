import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeServe } from './serve';

const savedEnv = { ...process.env };
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  process.env = { ...savedEnv };
});

/** Isolated install so the test never touches the real ~/.netpro. */
function scratchEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-cli-serve-'));
  dirs.push(dir);
  return { NETPRO_HOME: dir, DB_PATH: join(dir, 'netpro.db') };
}

describe('netpro serve (CLI → @netpro/server)', () => {
  it('starts the server, serves health, and shuts down on the stop signal', async () => {
    const signals = ['SIGUSR2' as NodeJS.Signals]; // real handler wiring, test-safe trigger
    const env = scratchEnv();

    const started = executeServe(
      { host: '127.0.0.1', port: '0' },
      { env, signals }
    );
    // The handle resolves once the server is listening.
    const handle = await started;

    const res = await fetch(`${handle.url}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dialect: string }).dialect).toBe('sqlite');
    // Flags win over env and defaults.
    expect(handle.host).toBe('127.0.0.1');

    // Graceful shutdown via the bound signal (what Ctrl+C does in production).
    process.kill(process.pid, 'SIGUSR2');
    const stop = await handle.stopped;
    expect(stop).toEqual({ reason: 'signal', signal: 'SIGUSR2' });
  });

  it('rejects a non-numeric --port before starting anything', async () => {
    await expect(
      executeServe({ port: 'http' }, { env: scratchEnv(), signals: [] })
    ).rejects.toThrow(/Invalid --port/);
  });

  it('surfaces EADDRINUSE from the server as an actionable failure', async () => {
    const env = scratchEnv();
    const first = await executeServe({ host: '127.0.0.1', port: '0' }, { env, signals: [] });
    try {
      await expect(
        executeServe({ host: '127.0.0.1', port: String(first.port) }, { env, signals: [] })
      ).rejects.toThrow(/already in use.*--port/s);
    } finally {
      await first.close();
      await first.stopped;
    }
  });
});
