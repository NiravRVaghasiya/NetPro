import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations } from '@netpro/db';
import { createApp } from './app';
import { startServer } from './server';
import type { AuthPolicy } from './auth/index';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-server-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_PATH = path;
  const conn = createDb();
  return { conn, path };
}

const LOCAL_POLICY: AuthPolicy = {
  mode: 'local',
  token: null,
  installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
};

describe('@netpro/server app', () => {
  it('creates an app that imports @netpro/core and @netpro/db', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY });
    expect(app.conn.dialect).toBe('sqlite');
    expect(app.jobs.list()).toEqual([]);
    expect(app.events).toBeDefined();
    expect(app.auth.mode).toBe('local');
    await app.close();
  });

  it('serves GET /api/health without any cloud service or the Web UI', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      auth: LOCAL_POLICY,
      config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } },
    });
    const running = await startServer(app, { port: 0 });

    try {
      const res = await fetch(`${running.url}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        dialect: string;
      };
      expect(body.status).toBe('healthy');
      expect(body.dialect).toBe('sqlite');
      expect(res.headers.get('x-request-id')).toBeTruthy();

      // `/` is the built-in local console page (Phase 2 banner promises a UI).
      const root = await fetch(running.url);
      expect(root.status).toBe(200);
      expect(root.headers.get('content-type')).toContain('text/html');
      const rootHtml = await root.text();
      expect(rootHtml).toContain('NetPro');
      expect(rootHtml).toContain('/api/health');
      expect(rootHtml).toContain('ins_test');

      // Machine-readable service info stays available as JSON.
      const info = await fetch(`${running.url}/api/server-info`);
      expect(info.status).toBe(200);
      const infoBody = (await info.json()) as { service: string; authMode: string };
      expect(infoBody.service).toBe('@netpro/server');
      expect(infoBody.authMode).toBe('local');

      const missing = await fetch(`${running.url}/api/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it('exposes verbose health detail for trusted local callers', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      auth: LOCAL_POLICY,
      config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } },
    });
    const running = await startServer(app, { port: 0 });

    try {
      const res = await fetch(`${running.url}/api/health?verbose=1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        migrations?: { applied: number; expected: number };
        search?: { mode: string };
      };
      expect(body.status).toBe('healthy');
      expect(body.migrations).toBeDefined();
      expect(body.migrations!.applied).toBeGreaterThan(0);
      expect(body.migrations!.expected).toBe(body.migrations!.applied);
      expect(body.search?.mode).toMatch(/portable|keyword|hybrid/);
    } finally {
      await running.close();
    }
  });

  it('serves the local installation identity to the operator (phase 5)', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY });
    const running = await startServer(app, { port: 0 });

    try {
      const res = await fetch(`${running.url}/api/identity`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authenticated: boolean;
        kind: string;
        tokenConfigured: boolean;
        installation: { id: string; createdAt: string | null; owner: string | null } | null;
      };
      expect(body.authenticated).toBe(true);
      expect(body.kind).toBe('loopback');
      expect(body.tokenConfigured).toBe(false);
      expect(body.installation?.id).toBe('ins_test');
      // The token itself is never echoed — only whether one exists.
      expect(JSON.stringify(body)).not.toContain('np_');
    } finally {
      await running.close();
    }
  });

  it('requires the access token when the policy says every request needs one', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const policy: AuthPolicy = {
      mode: 'token',
      token: 'np_ci_test_token',
      installation: LOCAL_POLICY.installation,
    };
    const app = await createApp({ conn, skipMigrate: true, auth: policy });
    const running = await startServer(app, { port: 0 });

    const authorized = { Authorization: 'Bearer np_ci_test_token' };
    try {
      // Public probe stays public, in every mode.
      expect((await fetch(`${running.url}/api/health`)).status).toBe(200);

      // Loopback is NOT implicitly trusted in token mode.
      const anonymous = await fetch(`${running.url}/api/identity`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
      const body = (await anonymous.json()) as { reason: string; authMode: string };
      expect(body.reason).toBe('missing-credentials');
      expect(body.authMode).toBe('token');

      const rootAnonymous = await fetch(running.url);
      expect(rootAnonymous.status).toBe(401);
      expect(await rootAnonymous.text()).toContain('local access only');

      const wrong = await fetch(`${running.url}/api/identity`, {
        headers: { Authorization: 'Bearer not-the-token' },
      });
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as { reason: string }).reason).toBe('invalid-credentials');

      const withToken = await fetch(`${running.url}/api/identity`, { headers: authorized });
      expect(withToken.status).toBe(200);
      expect(((await withToken.json()) as { kind: string }).kind).toBe('token');

      // `X-NetPro-Token` and `?token=` are accepted for non-browser clients
      // and EventSource, which cannot set an Authorization header.
      expect(
        (await fetch(`${running.url}/api/identity`, { headers: { 'X-NetPro-Token': 'np_ci_test_token' } })).status
      ).toBe(200);
      expect((await fetch(`${running.url}/api/identity?token=np_ci_test_token`)).status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('treats a proxied request as remote even from a loopback socket (phase 5)', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY });
    const running = await startServer(app, { port: 0 });

    try {
      // A reverse proxy on this machine connects from 127.0.0.1 but adds
      // X-Forwarded-For. Trusting the socket address there would expose every
      // proxied user as the local operator.
      const proxied = await fetch(`${running.url}/api/identity`, {
        headers: { 'X-Forwarded-For': '203.0.113.7' },
      });
      expect(proxied.status).toBe(401);
      const body = (await proxied.json()) as { hint: string };
      expect(body.hint).toContain('netpro token');
    } finally {
      await running.close();
    }
  });
});
