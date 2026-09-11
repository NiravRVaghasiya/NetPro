// Credentials API: encrypted save, masked reads, honest validation.
//
// Security assertions live here alongside the behaviour ones: no response
// may carry raw key material, failed validations must not change the stored
// key, and the vault stays read-only without a master key.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type SqliteConn } from '@netpro/db';
import { createApp } from './app';
import { startServer } from './server';
import type { AuthPolicy } from './auth/index';

const MASTER = 'test-master-key-that-is-long-enough-0123456789';
const HUNTER_KEY = 'hunter-secret-key-abcdef123456';
const OPENAI_KEY = 'sk-openai-secret-key-material-123';

const dirs: string[] = [];
const savedEnv = { ...process.env };

const PROVIDER_ENV_VARS = [
  'OPENAI_API_KEY',
  'NETPRO_OPENAI_KEY',
  'ANTHROPIC_API_KEY',
  'NETPRO_ANTHROPIC_KEY',
  'HUNTER_API_KEY',
  'PDL_API_KEY',
  'CLEARBIT_API_KEY',
  'EMBEDDINGS_API_KEY',
  'DEVTO_API_KEY',
  'TWITTER_BEARER_TOKEN',
  'GITHUB_TOKEN',
  'OPENAI_BASE_URL',
];

beforeEach(() => {
  process.env.ENCRYPTION_MASTER_KEY = MASTER;
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-credentials-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_PATH = path;
  const conn = createDb() as SqliteConn;
  return { conn, path, dir };
}

const LOCAL_POLICY: AuthPolicy = {
  mode: 'local',
  token: null,
  installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
};

async function startedServer() {
  const { conn } = scratchDb();
  await runMigrations(conn);
  const app = await createApp({
    conn,
    skipMigrate: true,
    auth: LOCAL_POLICY,
    config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } },
  });
  const running = await startServer(app, { port: 0 });
  return { running, conn };
}

// The provider checks use global fetch — stub it, but let the test's own
// HTTP calls to the scratch server through to the real implementation.
const realFetch = globalThis.fetch.bind(globalThis);

function isLocalCall(input: unknown): boolean {
  const url = String((input as { url?: unknown })?.url ?? input);
  return url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
}

function stubFetch(status: number) {
  const fn = vi.fn(async (input: any, init?: any) => {
    if (isLocalCall(input)) return realFetch(input, init);
    return new Response('{}', { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function stubFetchDown() {
  const fn = vi.fn(async (input: any, init?: any) => {
    if (isLocalCall(input)) return realFetch(input, init);
    throw new Error('provider unreachable');
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Calls the stub answered as the provider (not the test's server calls). */
function remoteCalls(fn: ReturnType<typeof stubFetch>): unknown[][] {
  return fn.mock.calls.filter(([input]) => !isLocalCall(input));
}

function hunterOf(body: any) {
  return (body.providers as any[]).find((p) => p.id === 'hunter');
}

describe('credentials API', () => {
  it('GET /api/credentials lists every provider unconfigured on a fresh install', async () => {
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.vault).toEqual({ available: true });
      expect(body.providers).toHaveLength(9);
      for (const provider of body.providers) {
        expect(provider.configured).toBe(false);
        expect(provider.source).toBe('none');
        expect(provider.lastFour).toBeNull();
        expect(provider.label.length).toBeGreaterThan(0);
      }
      expect(hunterOf(body).remotelyValidatable).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('reports the vault unavailable without a master key', async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.vault).toEqual({ available: false });
    } finally {
      await running.close();
    }
  });

  it('PUT validates remotely, then saves encrypted and answers masked', async () => {
    const fetchImpl = stubFetch(200);
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.validated).toBe(true);
      expect(body.warnings).toEqual([]);
      expect(body.provider).toMatchObject({
        id: 'hunter',
        label: 'Hunter',
        configured: true,
        source: 'vault',
        lastFour: HUNTER_KEY.slice(-4),
      });
      expect(body.provider.updatedAt).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(HUNTER_KEY);
      // The check really went out (to the stubbed provider, not the server).
      expect(remoteCalls(fetchImpl)).toHaveLength(1);
      expect(String(remoteCalls(fetchImpl)[0]![0])).toContain('https://api.hunter.io/v2/account');

      const list = (await (await fetch(`${running.url}/api/credentials`)).json()) as any;
      expect(hunterOf(list)).toMatchObject({ configured: true, source: 'vault' });
      expect(JSON.stringify(list)).not.toContain(HUNTER_KEY);

      // The provider strips pick the vault key up with source "vault".
      const providers = (await (await fetch(`${running.url}/api/providers`)).json()) as any;
      const hunter = (providers.catalog as any[]).find((p) => p.id === 'hunter');
      expect(hunter).toMatchObject({ configured: true, source: 'vault' });
      const enrichmentStrip = (providers.categories as any[]).find((c) => c.id === 'enrichment');
      expect(enrichmentStrip.detail).toContain('Hunter');
      expect(JSON.stringify(providers)).not.toContain(HUNTER_KEY);
    } finally {
      await running.close();
    }
  });

  it('PUT rejects an unknown provider, a short key, and a missing key', async () => {
    const { running } = await startedServer();
    try {
      const unknown = await fetch(`${running.url}/api/credentials/nope`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      expect(unknown.status).toBe(400);

      const short = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'short' }),
      });
      expect(short.status).toBe(400);
      const shortBody = (await short.json()) as any;
      expect(shortBody.code).toBe('invalid_key');

      const missing = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it('PUT refuses to write without a master key', async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    const fetchImpl = stubFetch(200);
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.code).toBe('vault_unavailable');
      expect(body.error).toContain('ENCRYPTION_MASTER_KEY');
      // Fails before any network call.
      expect(remoteCalls(fetchImpl)).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('PUT leaves the stored key untouched when validation fails', async () => {
    stubFetch(200);
    const { running } = await startedServer();
    try {
      const first = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      expect(first.status).toBe(200);

      stubFetch(401);
      const rejected = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'another-valid-looking-key-9999' }),
      });
      expect(rejected.status).toBe(422);
      const rejectedBody = (await rejected.json()) as any;
      expect(rejectedBody.code).toBe('validation_failed');
      expect(JSON.stringify(rejectedBody)).not.toContain('9999');

      stubFetchDown();
      const down = await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'another-valid-looking-key-8888' }),
      });
      expect(down.status).toBe(502);

      // The original key is still the stored one.
      const list = (await (await fetch(`${running.url}/api/credentials`)).json()) as any;
      expect(hunterOf(list)).toMatchObject({
        configured: true,
        source: 'vault',
        lastFour: HUNTER_KEY.slice(-4),
      });
    } finally {
      await running.close();
    }
  });

  it('PUT replaces a stored key when the new one validates', async () => {
    stubFetch(200);
    const { running } = await startedServer();
    try {
      await fetch(`${running.url}/api/credentials/openai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: OPENAI_KEY }),
      });
      const replacement = 'sk-replacement-key-material-9999';
      const res = await fetch(`${running.url}/api/credentials/openai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: replacement }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.provider.lastFour).toBe('9999');
      expect(JSON.stringify(body)).not.toContain(replacement);
    } finally {
      await running.close();
    }
  });

  it('PUT saves honestly without remote validation where no safe check exists', async () => {
    const fetchImpl = stubFetch(200);
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials/pdl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'pdl-secret-key-material-1234' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.validated).toBe(false);
      expect(body.provider.configured).toBe(true);
      expect(remoteCalls(fetchImpl)).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('POST /test checks the stored key without ever returning it', async () => {
    stubFetch(200);
    const { running } = await startedServer();
    try {
      await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });

      const ok = await fetch(`${running.url}/api/credentials/hunter/test`, { method: 'POST' });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as any;
      expect(okBody).toMatchObject({ provider: 'hunter', status: 'valid' });
      expect(JSON.stringify(okBody)).not.toContain(HUNTER_KEY);

      stubFetch(401);
      const bad = await fetch(`${running.url}/api/credentials/hunter/test`, { method: 'POST' });
      const badBody = (await bad.json()) as any;
      expect(badBody.status).toBe('invalid');

      const missing = await fetch(`${running.url}/api/credentials/github/test`, { method: 'POST' });
      expect(missing.status).toBe(404);

      // Unsupported providers 404 when nothing is stored…
      const missingUnsupported = await fetch(`${running.url}/api/credentials/pdl/test`, {
        method: 'POST',
      });
      expect(missingUnsupported.status).toBe(404);

      // …and report honestly once a key exists.
      await fetch(`${running.url}/api/credentials/pdl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'pdl-secret-key-material-1234' }),
      });
      const unsupported = await fetch(`${running.url}/api/credentials/pdl/test`, { method: 'POST' });
      expect(unsupported.status).toBe(200);
      expect(((await unsupported.json()) as any).status).toBe('unsupported');
    } finally {
      await running.close();
    }
  });

  it('POST /test refuses to misreport a locked vault as unconfigured', async () => {
    stubFetch(200);
    const { running } = await startedServer();
    try {
      await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      delete process.env.ENCRYPTION_MASTER_KEY;
      const res = await fetch(`${running.url}/api/credentials/hunter/test`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).code).toBe('vault_unavailable');
    } finally {
      await running.close();
    }
  });

  it('DELETE removes the vault key but reports env configuration honestly', async () => {
    stubFetch(200);
    const { running } = await startedServer();
    try {
      await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      const res = await fetch(`${running.url}/api/credentials/hunter`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.removed).toBe(true);
      expect(body.provider.configured).toBe(false);
      expect(JSON.stringify(body)).not.toContain(HUNTER_KEY);

      process.env.HUNTER_API_KEY = 'env-key-material';
      await fetch(`${running.url}/api/credentials/hunter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: HUNTER_KEY }),
      });
      const again = await fetch(`${running.url}/api/credentials/hunter`, { method: 'DELETE' });
      const againBody = (await again.json()) as any;
      expect(againBody.provider).toMatchObject({ configured: true, source: 'env' });
      expect(againBody.message).toContain('HUNTER_API_KEY');
    } finally {
      await running.close();
    }
  });

  it('shows env-configured providers as configured without vault rows', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    const { running } = await startedServer();
    try {
      const res = await fetch(`${running.url}/api/credentials`);
      const body = (await res.json()) as any;
      const openai = (body.providers as any[]).find((p) => p.id === 'openai');
      expect(openai).toMatchObject({ configured: true, source: 'env', lastFour: null });
      expect(JSON.stringify(body)).not.toContain('env-openai-key');
    } finally {
      await running.close();
    }
  });
});
