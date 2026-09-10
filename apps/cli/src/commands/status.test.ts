import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runServe, type ServeHandle } from '@netpro/server';
import { executeStatus, formatStatus, resolveServerUrl } from './status';

/** A port that is (momentarily) guaranteed closed — for "server down" probes. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

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

function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-status-'));
  process.env.NETPRO_HOME = dir;
  process.env.DB_PATH = join(dir, 'netpro.db');
  return dir;
}

describe('netpro status', () => {
  it('reports a fresh install: db path, migrations, and a server that is not running', async () => {
    const home = scratchHome();
    // Probe a port we just closed, not the 3777 default — a developer's own
    // running instance must not turn this into a flake.
    const port = await closedPort();
    process.env.NETPRO_PORT = String(port);
    const result = await executeStatus();

    expect(result.home).toBe(home);
    expect(result.configExists).toBe(false);
    expect(result.database.dialect).toBe('sqlite');
    expect(result.database.display).toBe(join(home, 'netpro.db'));
    // Fresh file: no migrations journal yet — status says so instead of failing.
    expect(result.database.applied).toBeNull();
    expect(result.database.total).toBeGreaterThan(0);
    expect(result.database.error).toBeNull();

    expect(result.server.running).toBe(false);
    expect(result.server.url).toBe(`http://127.0.0.1:${port}`);
    expect(result.server.error).toBeTruthy();

    const text = formatStatus(result);
    expect(text).toContain('NetPro status');
    expect(text).toContain('(missing — run netpro init)');
    expect(text).toMatch(/not initialized — run netpro init/);
    expect(text).toMatch(/not running.*netpro serve/s);
  });

  it('probes a running local server end-to-end and reports health', async () => {
    const home = scratchHome();
    const handle = await runServe({ host: '127.0.0.1', port: 0, signals: [] });
    handles.push(handle);
    process.env.NETPRO_PORT = String(handle.port);

    const result = await executeStatus();
    expect(result.server.url).toBe(`http://127.0.0.1:${handle.port}`);
    expect(result.server.running).toBe(true);
    expect(result.server.status).toBe('healthy');
    expect(result.server.dialect).toBe('sqlite');
    expect(result.server.latencyMs).not.toBeNull();

    const text = formatStatus(result);
    expect(text).toContain(`running at http://127.0.0.1:${handle.port}`);
    expect(text).toContain('healthy');
    void home;
  });

  it('respects NETPRO_URL when probing a remote instance', async () => {
    scratchHome();
    process.env.NETPRO_URL = 'https://netpro.example.com/';
    expect(await resolveServerUrl()).toBe('https://netpro.example.com');
  });

  it('defaults the server endpoint to 127.0.0.1:3777 (URL resolution only, no probe)', async () => {
    scratchHome();
    delete process.env.NETPRO_PORT;
    delete process.env.NETPRO_URL;
    expect(await resolveServerUrl()).toBe('http://127.0.0.1:3777');
  });

  it('reports provider status and says NetPro runs without them (Phase 17)', async () => {
    scratchHome();
    for (const key of ['OPENAI_API_KEY', 'HUNTER_API_KEY', 'PDL_API_KEY', 'CLEARBIT_API_KEY']) {
      delete process.env[key];
    }
    delete process.env.EMBEDDINGS_PROVIDER;

    const result = await executeStatus();
    expect(result.providers.runsWithoutProviders).toBe(true);
    expect(result.providers.capabilities.keywordSearch).toBe('available');
    expect(result.providers.capabilities.enrichment).toBe('disabled');

    const text = formatStatus(result);
    expect(text).toContain('Providers');
    expect(text).toContain('all optional');
    expect(text).toContain('AI');
    expect(text).toContain('Not configured');
    expect(text).toContain('Embeddings');
    expect(text).toContain('Disabled');
  });

  it('shows a configured provider in status without printing the key (Phase 17)', async () => {
    scratchHome();
    process.env.HUNTER_API_KEY = 'SECRET-HUNTER-KEY';
    try {
      const result = await executeStatus();
      expect(result.providers.enrichment.configured).toBe(true);
      const text = formatStatus(result);
      expect(text).toContain('Hunter configured');
      expect(text).not.toContain('SECRET-HUNTER-KEY');
    } finally {
      delete process.env.HUNTER_API_KEY;
    }
  });

  it('surfaces an invalid config.toml as status errors instead of crashing', async () => {
    const home = scratchHome();
    writeFileSync(join(home, 'config.toml'), '[server]\nport = "not-a-number"\n');
    const result = await executeStatus();
    expect(result.database.error).toMatch(/port must be an integer/);
    expect(result.server.error).toMatch(/port must be an integer/);
    expect(result.server.running).toBe(false);
    expect(result.server.url).toBe('');
    void home;
  });
});
