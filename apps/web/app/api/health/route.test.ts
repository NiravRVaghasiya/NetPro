import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
const authMock = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));

import { GET } from './route';

const call = (query = '') =>
  GET(new Request(`https://netpro.example/api/health${query}`));

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue(null);
});

describe('GET /api/health', () => {
  it('reports healthy against a migrated database', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.dialect).toBe('sqlite');
    expect(typeof body.latencyMs).toBe('number');
  });

  it('is never cached by a proxy or CDN', async () => {
    expect((await call()).headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('hides migration detail from anonymous callers', async () => {
    // The probe is public, so it must not help fingerprint the deployment.
    const body = await (await call('?verbose')).json();
    expect(body.migrations).toBeUndefined();
  });

  it('reveals migration counts to the signed-in owner', async () => {
    authMock.mockResolvedValue({ user: { id: 'owner' } });
    const body = await (await call('?verbose')).json();
    expect(body.migrations.applied).toBeGreaterThan(0);
    expect(body.migrations.applied).toBe(body.migrations.expected);
  });

  it('stays up when the session lookup itself fails', async () => {
    authMock.mockRejectedValue(new Error('JWT decryption failed'));
    expect((await call('?verbose')).status).toBe(200);
  });

  it('reports 503 degraded when the schema was never migrated', async () => {
    // A database that answers SELECT 1 but has no tables is a deploy whose
    // migration step did not run — a rollout gate must catch that.
    const bare = await import('better-sqlite3').then((m) => new m.default(':memory:'));
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('@netpro/db/src/schema.sqlite');
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      conn: { dialect: 'sqlite', db: drizzle(bare, { schema }), schema },
    }));
    vi.doMock('@/lib/auth', () => ({ auth: async () => null }));
    const { GET: freshGet } = await import('./route');
    const response = await freshGet(new Request('https://netpro.example/api/health'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.error).toMatch(/not initialized/i);
    bare.close();
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/auth');
    vi.resetModules();
  });

  it('does not leak driver errors to anonymous callers', async () => {
    const failing = {
      dialect: 'postgresql' as const,
      db: {
        execute: async () => {
          throw new Error(
            'connect ECONNREFUSED 10.1.2.3:5432 for user netpro on db prod-secret'
          );
        },
      },
    };
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ conn: failing }));
    vi.doMock('@/lib/auth', () => ({ auth: async () => null }));
    const { GET: freshGet } = await import('./route');
    const response = await freshGet(new Request('https://netpro.example/api/health'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('Database is unavailable.');
    // The host, port, user, and database name must not appear anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('10.1.2.3');
    expect(serialized).not.toContain('prod-secret');
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/auth');
    vi.resetModules();
  });
});

// Keep the shared fixture from leaking into other suites' file handles.
process.on('exit', () => fixture.sqlite.close());
