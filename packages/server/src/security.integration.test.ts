// Phase 23 — security integration tests over real HTTP: hardening headers,
// console CSP, the CORS origin policy, per-IP rate limiting, and the
// /api/settings credential redaction. One app per test, so each rate limiter
// starts empty and nothing leaks between cases.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type SqliteConn } from '@netpro/db';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { startServer } from './server';
import type { AuthPolicy } from './auth/index';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-phase23-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_PATH = path;
  delete process.env.DATABASE_URL;
  const conn = createDb() as SqliteConn;
  return { conn, path, dir };
}

const LOCAL_POLICY: AuthPolicy = {
  mode: 'local',
  token: null,
  installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
};

function tokenPolicy(): AuthPolicy {
  return { mode: 'token', token: 'np_test123', installation: LOCAL_POLICY.installation };
}

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    autoMigrate: false,
    auth: { mode: 'local' },
    ...overrides,
  };
}

describe('Phase 23 security headers', () => {
  it('sends hardening headers on API, console, and error responses — HSTS only when enabled', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: baseConfig() });
    const running = await startServer(app, { port: 0 });
    try {
      for (const path of ['/api/health', '/', '/api/contacts/nonexistent']) {
        const res = await fetch(`${running.url}${path}`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('strict-transport-security')).toBeNull();
        await res.text();
      }
      // Opt-in HSTS appears once enabled.
      const tlsApp = await createApp({
        conn,
        skipMigrate: true,
        auth: LOCAL_POLICY,
        config: baseConfig({ hsts: true }),
      });
      const tls = await startServer(tlsApp, { port: 0 });
      try {
        const res = await fetch(`${tls.url}/api/health`);
        expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
        await res.text();
      } finally {
        await tls.close();
      }
    } finally {
      await running.close();
    }
  });

  it('serves the console pages with a strict self-only CSP', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: baseConfig() });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/`);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain('*');
      await res.text();

      // The locked page (unauthenticated remote caller) is hardened too.
      const remoteApp = await createApp({
        conn,
        skipMigrate: true,
        auth: tokenPolicy(),
        config: baseConfig({ auth: { mode: 'token' } }),
      });
      const remote = await startServer(remoteApp, { port: 0 });
      try {
        const locked = await fetch(`${remote.url}/`);
        expect(locked.status).toBe(401);
        expect(locked.headers.get('content-security-policy')).toContain("default-src 'none'");
        await locked.text();
      } finally {
        await remote.close();
      }
    } finally {
      await running.close();
    }
  });
});

describe('Phase 23 CORS origin policy', () => {
  it('grants loopback origins and refuses internet origins by default', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      auth: tokenPolicy(),
      config: baseConfig({ auth: { mode: 'token' } }),
    });
    const running = await startServer(app, { port: 0 });
    try {
      const headers = { Authorization: 'Bearer np_test123' };
      const loopback = await fetch(`${running.url}/api/contacts`, {
        headers: { ...headers, Origin: 'http://localhost:3000' },
      });
      expect(loopback.status).toBe(200);
      expect(loopback.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      await loopback.text();

      // Authenticated but disallowed: no CORS grant.
      const evil = await fetch(`${running.url}/api/contacts`, {
        headers: { ...headers, Origin: 'https://evil.example.com' },
      });
      expect(evil.status).toBe(200); // the API answers; the *browser grant* is withheld
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      expect(evil.headers.get('vary')).toContain('Origin');
      await evil.text();

      // Unauthenticated: no grant even for loopback.
      const anon = await fetch(`${running.url}/api/contacts`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(anon.status).toBe(401);
      expect(anon.headers.get('access-control-allow-origin')).toBeNull();
      await anon.text();
    } finally {
      await running.close();
    }
  });

  it('honours an explicit allow-list, replacing the loopback default', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      auth: tokenPolicy(),
      config: baseConfig({ auth: { mode: 'token' }, allowedOrigins: ['https://ui.example.com'] }),
    });
    const running = await startServer(app, { port: 0 });
    try {
      const headers = { Authorization: 'Bearer np_test123' };
      const listed = await fetch(`${running.url}/api/contacts`, {
        headers: { ...headers, Origin: 'https://ui.example.com' },
      });
      expect(listed.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
      await listed.text();

      const unlisted = await fetch(`${running.url}/api/contacts`, {
        headers: { ...headers, Origin: 'http://localhost:3000' },
      });
      expect(unlisted.headers.get('access-control-allow-origin')).toBeNull();
      await unlisted.text();
    } finally {
      await running.close();
    }
  });
});

describe('Phase 23 rate limiting', () => {
  it('429s past the per-IP budget with Retry-After while probes stay unlimited', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({
      conn,
      skipMigrate: true,
      auth: LOCAL_POLICY,
      config: baseConfig({ rateLimit: { enabled: true, max: 2, windowMs: 60_000 } }),
    });
    const running = await startServer(app, { port: 0 });
    try {
      expect((await fetch(`${running.url}/api/contacts`)).status).toBe(200);
      expect((await fetch(`${running.url}/api/contacts`)).status).toBe(200);
      const limited = await fetch(`${running.url}/api/contacts`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      const body = (await limited.json()) as any;
      expect(body.code).toBe('rate_limited');
      expect(body.retryAfterMs).toBeGreaterThan(0);

      // Probes are exempt: health and server-info answer through the limit.
      expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${running.url}/api/server-info`)).status).toBe(200);
      // Preflights are exempt too.
      const preflight = await fetch(`${running.url}/api/contacts`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
    } finally {
      await running.close();
    }
  });

  it('stays out of the way at the default budget', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: baseConfig() });
    expect(app.rateLimit).toBeDefined();
    const running = await startServer(app, { port: 0 });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${running.url}/api/contacts`);
        expect(res.status).toBe(200);
        await res.text();
      }
    } finally {
      await running.close();
    }
  });
});

describe('Phase 23 settings redaction', () => {
  it('redacts the database password from the echoed config file', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const home = mkdtempSync(join(tmpdir(), 'netpro-phase23-home-'));
    dirs.push(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.toml'),
      '[database]\ndialect = "postgresql"\nurl = "postgres://netpro:s3cret@db:5432/netpro"\n'
    );
    process.env.NETPRO_HOME = home;

    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: baseConfig() });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/settings`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const echoedUrl: string = body.configFile.database.url;
      expect(echoedUrl).toContain('db:5432/netpro');
      expect(echoedUrl).not.toContain('s3cret');
    } finally {
      await running.close();
    }
  });
});
