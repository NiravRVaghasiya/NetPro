import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations } from '@netpro/db';
import { createApp } from './app';
import { startServer } from './server';

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
  // Avoid Vercel guard if somehow set in CI.
  delete process.env.VERCEL;
  const conn = createDb();
  return { conn, path };
}

describe('@netpro/server app', () => {
  it('creates an app that imports @netpro/core and @netpro/db', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true });
    expect(app.conn.dialect).toBe('sqlite');
    expect(app.jobs.list()).toEqual([]);
    expect(app.events).toBeDefined();
    await app.close();
  });

  it('serves GET /api/health without Vercel or the Web UI', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      config: { host: '127.0.0.1', port: 0, autoMigrate: false },
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

      // Machine-readable service info stays available as JSON.
      const info = await fetch(`${running.url}/api/server-info`);
      expect(info.status).toBe(200);
      const infoBody = (await info.json()) as { service: string };
      expect(infoBody.service).toBe('@netpro/server');

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
      config: { host: '127.0.0.1', port: 0, autoMigrate: false },
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
});
