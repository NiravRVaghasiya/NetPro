// Live PostgreSQL integration tests.
//
// Phases 1–5 shipped Postgres support that compiled and had committed
// migrations, but was never executed against a real PostgreSQL server — the
// Phase 5 verification record says so explicitly. That gap is what let the
// concurrent-migration race below reach the v1.0 release candidate.
//
// These tests are SKIPPED unless NETPRO_TEST_DATABASE_URL points at a
// disposable PostgreSQL server, so the default `npm test` stays hermetic and
// offline. CI runs them against a postgres service container; locally:
//
//   docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=netpro postgres:16-alpine
//   NETPRO_TEST_DATABASE_URL=postgresql://postgres:netpro@127.0.0.1:5433/postgres \
//     npm test -w packages/db
//
// Each test provisions its own throwaway database so runs cannot interfere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.pg';
import type { PgConn } from './index';
import {
  appliedMigrationCount,
  pendingMigrationTotal,
  resolveMigrationsFolder,
  runMigrations,
} from './migrate';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const created: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `netpro_test_${label}_${Date.now().toString(36)}`;
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
  created.push(name);
  return name;
}

function connect(name: string): PgConn {
  const pool = new Pool({ connectionString: databaseUrl(name) });
  return { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
}

describeIfPg('PostgreSQL integration', () => {
  let dbName: string;
  let conn: PgConn;

  beforeAll(async () => {
    dbName = await freshDatabase('main');
    conn = connect(dbName);
    await runMigrations(conn, { force: true });
  }, 60_000);

  afterAll(async () => {
    await conn?.pool.end();
    for (const name of created) {
      await withAdmin(async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [name]
        );
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      }).catch(() => {
        // Best effort cleanup of a throwaway database.
      });
    }
  }, 60_000);

  it('applies every committed migration to a fresh database', async () => {
    expect(await appliedMigrationCount(conn)).toBe(
      pendingMigrationTotal('postgresql')
    );

    const tables = await conn.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = tables.rows.map((row) => row.table_name);
    // The Auth.js adapter tables use singular names; the domain tables plural.
    for (const expected of [
      'contacts',
      'interactions',
      'edges',
      'enrichments',
      'campaigns',
      'campaign_recipients',
      'search_index',
      'profile_views',
      'follow_ups',
      'activity_log',
      'profile_cards',
      'events',
      'event_attendees',
      'user',
      'account',
      'session',
      'verificationToken',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent when re-run against an already migrated database', async () => {
    const before = await appliedMigrationCount(conn);
    await runMigrations(conn, { force: true });
    await runMigrations(conn, { force: true });
    expect(await appliedMigrationCount(conn)).toBe(before);
  });

  it('round-trips a contact through real Postgres types', async () => {
    await conn.db.insert(schema.contacts).values({
      id: 'pg-roundtrip',
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'test',
      relationshipScore: 0.75,
      interactionCount: 3,
      emailVerified: true,
    });
    const rows = await conn.db.select().from(schema.contacts);
    const row = rows.find((r) => r.id === 'pg-roundtrip');
    expect(row?.fullName).toBe('Ada Lovelace');
    // real/boolean/integer must survive the pg driver, not just SQLite's
    // permissive dynamic typing.
    expect(row?.relationshipScore).toBeCloseTo(0.75);
    expect(row?.emailVerified).toBe(true);
    expect(row?.interactionCount).toBe(3);
  });

  it('stores the profile card as plain JSON text in both dialects', async () => {
    const profile = JSON.stringify({ fullName: 'Grace Hopper' });
    await conn.db
      .insert(schema.profileCards)
      .values({ id: 'default', draft: profile, updatedAt: new Date().toISOString() });
    const [card] = await conn.db.select().from(schema.profileCards);
    // Postgres must hand back the raw string, matching SQLite. A jsonb column
    // would auto-decode here and silently diverge from the SQLite dialect.
    expect(typeof card?.draft).toBe('string');
    expect(card?.draft).toBe(profile);
  });

  it(
    'survives concurrent cold-start migrations of one fresh database',
    async () => {
      // THE PHASE 6 REGRESSION TEST.
      //
      // A Vercel deploy cold-starts many instances at once, and each one
      // migrates on startup. Calling drizzle's migrate() directly here
      // reproducibly failed 5 of 6 workers against real PostgreSQL 18:
      //   -> Failed query: CREATE TABLE "account" (...)
      //   -> Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
      // (IF NOT EXISTS is itself racy in Postgres: the check and the create
      // are not atomic.) runMigrations() serializes them with an advisory
      // lock, so exactly one applies and the rest no-op.
      const name = await freshDatabase('race');
      const workers = Array.from({ length: 6 }, () => connect(name));
      try {
        const results = await Promise.allSettled(
          workers.map((worker) => runMigrations(worker, { force: true }))
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(
          rejected.map((r) => String((r as PromiseRejectedResult).reason?.message))
        ).toEqual([]);

        // Applied exactly once, not six times.
        expect(await appliedMigrationCount(workers[0]!)).toBe(
          pendingMigrationTotal('postgresql')
        );
      } finally {
        await Promise.all(workers.map((worker) => worker.pool.end()));
      }
    },
    120_000
  );

  it('caches migration work per process so warm requests do not re-migrate', async () => {
    const cached = connect(dbName);
    try {
      const first = runMigrations(cached);
      const second = runMigrations(cached);
      // Same in-flight promise, not a second round trip.
      expect(second).toBe(first);
      await first;
    } finally {
      await cached.pool.end();
    }
  });

  it('exposes a migrations folder for the postgres dialect', () => {
    expect(resolveMigrationsFolder('postgresql')).toMatch(/migrations[/\\]postgres$/);
  });
});
