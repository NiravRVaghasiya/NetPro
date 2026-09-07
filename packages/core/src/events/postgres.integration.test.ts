// Live PostgreSQL coverage for the v2.0 Phase 6 event matcher.
//
// WHY THIS FILE EXISTS. The events module reads through raw ANSI SQL (the
// same `rawAll` helper the search indexer and the skills module use) and
// writes through Drizzle. "ANSI" is a claim, not a proof: `ESCAPE '\'`,
// `ORDER BY (col IS NULL)`, correlated count subqueries, `COUNT(DISTINCT …)`
// and boolean/text round-trips all have to survive a real server, and a
// second dialect is the only thing that can contradict them. The
// activity_log "unmatched bucket" is the sharpest edge — it is JSON on
// SQLite and plain text on Postgres, so this test is where that difference
// either shows up or is proven harmless.
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// `npm test` stays hermetic and offline. CI's postgres job supplies it.
//
// ONE DATABASE, TESTS IN ORDER. Unlike the SQLite suite (where every test
// gets a fresh in-memory database), all eight tests here share one database
// and build on each other the way the search suite does — the import in the
// first test is what the later assertions read back. So any new test has to
// be written against the state the tests above it left behind, not against an
// empty graph: in particular the a–b pair is already a *pending* edge by the
// time the "links and unlinks" test runs, which is why it links `c`.
//
// (An earlier version of that test linked `b` and asserted a fresh edge was
// created. It passed alone and failed in the file — the merge path is
// correct, the expectation was not. Both paths are now pinned down: merge in
// `repository.test.ts`, creation here.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@netpro/db/src/schema.pg';
import { runMigrations } from '@netpro/db';
import type { PgConn } from '@netpro/db';
import {
  eventsStatus,
  getEvent,
  importEvents,
  linkAttendee,
  listContactEvents,
  listEvents,
  matchEventAttendees,
  recommendEvents,
  removeEvent,
  resolveEventRef,
  unlinkAttendee,
  upsertEvent,
} from './index';
import { listEdges } from '../graph/edges';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const dbName = `netpro_core_events_${Date.now().toString(36)}`;
const now = new Date('2026-09-07T12:00:00.000Z');

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describeIfPg('event matcher against live PostgreSQL', () => {
  let conn: PgConn;

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(`CREATE DATABASE "${dbName}"`);
    });
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString() });
    conn = { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
    await runMigrations(conn, { force: true });

    await conn.db.insert(schema.contacts).values([
      {
        id: 'a',
        fullName: 'Ada Lovelace',
        email: 'ada@engines.dev',
        company: 'Engines',
        industry: 'fintech',
        source: 'test',
        relationshipScore: 0.9,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: 'b',
        fullName: 'Bob Builder',
        email: 'bob@builders.io',
        company: 'Builders',
        industry: 'fintech',
        source: 'test',
        relationshipScore: 0.6,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: 'c',
        fullName: 'Cara Chen',
        email: 'cara@chen.dev',
        company: 'Chen',
        industry: 'devtools',
        source: 'test',
        relationshipScore: 0.3,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: 'gone',
        fullName: 'Ghost',
        email: 'ghost@example.com',
        source: 'test',
        deletedAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await conn?.pool.end();
    await withAdmin(async (client) => {
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [
        dbName,
      ]);
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }).catch(() => {
      // Best effort cleanup of a throwaway database.
    });
  }, 60_000);

  const csv = [
    'name,location,starts_at,attendees',
    'React Conf,Berlin,2026-09-14,"ada@engines.dev; bob@builders.io; nobody@nowhere.dev"',
  ].join('\n');

  it('imports, matches and links attendees — and is idempotent', async () => {
    const first = await importEvents(conn, { csv, now });
    expect(first.created).toBe(1);
    expect(first.matched).toBe(2);
    expect(first.attendees).toBe(2);
    expect(first.edges).toBe(1);

    const second = await importEvents(conn, { csv, now });
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    expect(second.attendees).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it('writes imported co-attendee edges as pending', async () => {
    const edges = await listEdges(conn, { relation: 'met_at_event' });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ status: 'pending', source: 'event_import' });
  });

  it('keeps the unmatched bucket through a JSON/text round-trip', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    const detail = await getEvent(conn, event.id);
    expect(detail!.unmatched).toEqual([
      { name: null, email: 'nobody@nowhere.dev', reason: 'no contact matches "nobody@nowhere.dev"' },
    ]);
  });

  it('lists events with counts, filters, LIKE escaping and pagination', async () => {
    await importEvents(
      conn,
      {
        csv: ['name,starts_at,attendees', 'RustConf,2020-03-01,ada@engines.dev', '100% Conf,2026-10-01,'].join('\n'),
        now,
      }
    );
    const all = await listEvents(conn, { limit: 50, now });
    expect(all.total).toBe(3);
    expect(all.events.map((e) => e.name)).toEqual(['100% Conf', 'React Conf', 'RustConf']);
    expect(all.events.find((e) => e.name === 'React Conf')!.attendeeCount).toBe(2);

    // `%` and `_` in a query are literals, not wildcards.
    const literal = await listEvents(conn, { query: '100%', limit: 10, now });
    expect(literal.events.map((e) => e.name)).toEqual(['100% Conf']);

    const upcoming = await listEvents(conn, { upcoming: true, limit: 10, now });
    expect(upcoming.events.map((e) => e.name)).toEqual(['100% Conf', 'React Conf']);

    const page = await listEvents(conn, { limit: 2, offset: 1, now });
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('links and unlinks an attendee with a confirmed edge', async () => {
    const { event } = await upsertEvent(conn, { name: 'Private Dinner', location: 'Lisbon' }, { now });
    const first = await linkAttendee(conn, { eventId: event.id, contactId: 'a', via: 'manual' }, { now });
    expect(first.created).toBe(true);

    // `c`, not `b`: the import above already wrote a pending a–b edge, so a
    // manual link there would merge an existing row instead of minting one.
    // a–c has never met, so this is the "create" path.
    const second = await linkAttendee(conn, { eventId: event.id, contactId: 'c', via: 'manual' }, { now });
    expect(second.edgesCreated).toBe(1);
    const confirmed = await listEdges(conn, { relation: 'met_at_event', status: 'confirmed' });
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed[0]).toMatchObject({ status: 'confirmed', confidence: 1, source: 'event_import' });

    const detail = await getEvent(conn, event.id);
    expect(detail!.attendees.map((a) => a.contactId)).toEqual(['a', 'c']);
    expect(detail!.industries).toEqual(['devtools', 'fintech']);

    expect((await unlinkAttendee(conn, { eventId: event.id, contactId: 'a' })).removed).toBe(true);
    expect((await getEvent(conn, event.id))!.attendees.map((a) => a.contactId)).toEqual(['c']);
  });

  it('re-matches an event after the network grows', async () => {
    const { event } = await upsertEvent(conn, { name: 'Late Conf' }, { now });
    await importEvents(conn, { csv: 'name,attendees\nLate Conf,nobody@nowhere.dev', now });
    await conn.db.insert(schema.contacts).values({
      id: 'n',
      fullName: 'Nova Nowhere',
      email: 'nobody@nowhere.dev',
      source: 'test',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const preview = await matchEventAttendees(conn, event.id, { now });
    expect(preview.matched).toBe(1);
    expect(preview.linked).toBe(0);

    const applied = await matchEventAttendees(conn, event.id, { now, apply: true });
    expect(applied.linked).toBe(1);
    expect((await getEvent(conn, event.id))!.attendees.map((a) => a.contactId)).toEqual(['n']);
  });

  it('ranks recommendations and never surfaces a soft-deleted contact', async () => {
    const ranked = await recommendEvents(conn, { limit: 10, now });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.event.name).toBe('React Conf');
    expect(ranked[0]!.reasons).toContain('2 people in your network');
    for (const row of ranked) {
      expect(row.attendees.map((a) => a.contactId)).not.toContain('gone');
    }
  });

  it('reports status and per-contact events, and cascades on delete', async () => {
    const status = await eventsStatus(conn);
    expect(status.events).toBeGreaterThan(0);
    expect(status.contacts).toBe(4); // the soft-deleted contact is never counted
    expect(status.attendees).toBeGreaterThan(0);

    const forAda = await listContactEvents(conn, 'a');
    expect(forAda.map((e) => e.name)).toContain('React Conf');
    expect(forAda.every((e) => e.attendeeCount >= 1)).toBe(true);

    const target = await resolveEventRef(conn, '100% Conf');
    await removeEvent(conn, target.id);
    expect((await listEvents(conn, { query: '100%', limit: 10, now })).total).toBe(0);
  });
});
