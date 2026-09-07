import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { listEdges } from '../graph/edges';
import {
  EVENT_LIMITS,
  EventError,
  countEvents,
  eventsStatus,
  getEvent,
  importEvents,
  linkAttendee,
  listContactEvents,
  listEvents,
  loadMatchableContacts,
  matchEventAttendees,
  recommendEvents,
  removeEvent,
  resolveEventRef,
  unlinkAttendee,
  upsertEvent,
} from './index';

const fixture = createTestSqliteConn();
const conn = fixture.conn;
const now = new Date('2026-09-07T12:00:00Z');
const NOW = now.toISOString();

interface SeedContact {
  id: string;
  fullName: string;
  email?: string | null;
  company?: string | null;
  industry?: string | null;
  relationshipScore?: number;
  deletedAt?: string | null;
}

function seed(contacts: SeedContact[]): void {
  for (const c of contacts) {
    conn.db
      .insert(conn.schema.contacts)
      .values({
        id: c.id,
        fullName: c.fullName,
        email: c.email ?? null,
        company: c.company ?? null,
        industry: c.industry ?? null,
        relationshipScore: c.relationshipScore ?? 0.5,
        source: 'test',
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: c.deletedAt ?? null,
      })
      .run();
  }
}

function reset(): void {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
}

const PEOPLE: SeedContact[] = [
  { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', industry: 'fintech', relationshipScore: 0.9 },
  { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', company: 'Builders', industry: 'fintech', relationshipScore: 0.6 },
  { id: 'c', fullName: 'Cara Chen', email: 'cara@chen.dev', company: 'Chen', industry: 'devtools', relationshipScore: 0.3 },
  { id: 'dup1', fullName: 'Sam Same', email: 'sam1@example.com' },
  { id: 'dup2', fullName: 'Sam Same', email: 'sam2@example.com' },
  { id: 'gone', fullName: 'Ghost', email: 'ghost@example.com', deletedAt: NOW },
];

beforeEach(() => {
  reset();
  seed(PEOPLE);
});
afterAll(() => fixture.sqlite.close());

const csv = (rows: string[]): string => rows.join('\n');

describe('loadMatchableContacts', () => {
  it('returns live contacts only', async () => {
    const contacts = await loadMatchableContacts(conn);
    expect(contacts.map((c) => c.id)).toEqual(['a', 'b', 'c', 'dup1', 'dup2']);
  });
});

describe('upsertEvent', () => {
  it('creates an event and logs it', async () => {
    const { event, created } = await upsertEvent(
      conn,
      { name: 'React Conf', location: 'Berlin', startsAt: '2026-09-14', endsAt: '2026-09-16' },
      { now }
    );
    expect(created).toBe(true);
    expect(event).toMatchObject({
      name: 'React Conf',
      location: 'Berlin',
      startsAt: '2026-09-14T00:00:00.000Z',
      endsAt: '2026-09-16T00:00:00.000Z',
      source: 'manual',
    });
  });

  it('dedupes on normalized name instead of creating a twin', async () => {
    const first = await upsertEvent(conn, { name: 'React Conf' }, { now });
    const second = await upsertEvent(conn, { name: '  react conf  ' }, { now });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(await countEvents(conn)).toBe(1);
  });

  it('validates input the way every other NetPro writer does', async () => {
    await expect(upsertEvent(conn, { name: '   ' })).rejects.toThrow(EventError);
    await expect(upsertEvent(conn, { name: 'x'.repeat(201) })).rejects.toThrow(/200 characters/);
    await expect(upsertEvent(conn, { name: 'Ok', source: 'scraped' })).rejects.toThrow(/Unknown source/);
    await expect(upsertEvent(conn, { name: 'Ok', startsAt: '14/03/2026' })).rejects.toThrow(/not a date/);
    await expect(
      upsertEvent(conn, { name: 'Ok', startsAt: '2026-05-02', endsAt: '2026-05-01' })
    ).rejects.toThrow(/end before it starts/);
  });
});

describe('resolveEventRef', () => {
  it('resolves by id and by exact name', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    expect((await resolveEventRef(conn, event.id)).id).toBe(event.id);
    expect((await resolveEventRef(conn, 'react conf')).id).toBe(event.id);
  });

  it('refuses to guess between same-named events', async () => {
    await upsertEvent(conn, { name: 'React Conf', location: 'Berlin' }, { now });
    conn.db
      .insert(conn.schema.events)
      .values({
        id: 'second',
        name: 'react conf',
        location: 'Online',
        source: 'import',
        createdAt: NOW,
      })
      .run();
    await expect(resolveEventRef(conn, 'React Conf')).rejects.toThrow(/Ambiguous event/);
  });

  it('404s cleanly on an unknown selector', async () => {
    await expect(resolveEventRef(conn, 'nope')).rejects.toThrow(/No event found/);
    await expect(resolveEventRef(conn, '   ')).rejects.toThrow(/id or name is required/);
  });
});

describe('linkAttendee', () => {
  it('records attendance and links co-attendees with a confirmed edge', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    const first = await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    expect(first.created).toBe(true);
    expect(first.edgesCreated).toBe(0); // nobody else there yet

    const second = await linkAttendee(conn, { eventId: event.id, contactId: 'b' }, { now });
    expect(second.edgesCreated).toBe(1);

    const edges = await listEdges(conn, { relation: 'met_at_event' });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ relation: 'met_at_event', status: 'confirmed', confidence: 1 });
  });

  it('marks attendance as planned when the event has not started', async () => {
    const { event } = await upsertEvent(conn, { name: 'Future Conf', startsAt: '2026-12-01' }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    const detail = await getEvent(conn, event.id);
    expect(detail!.attendees[0]!.attended).toBe(false);
  });

  it('is idempotent: a second link is a duplicate, not a second row', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    const again = await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    expect(again.created).toBe(false);
    const detail = await getEvent(conn, event.id);
    expect(detail!.attendees).toHaveLength(1);
  });

  it('rejects unknown events and soft-deleted contacts', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    await expect(linkAttendee(conn, { eventId: 'nope', contactId: 'a' })).rejects.toThrow(/No event with id/);
    await expect(linkAttendee(conn, { eventId: event.id, contactId: 'gone' })).rejects.toThrow(/No contact/);
    await expect(linkAttendee(conn, { eventId: '', contactId: 'a' })).rejects.toThrow(/required/);
  });

  it('can skip the pairwise edges entirely', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'a', edges: false }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'b', edges: false }, { now });
    expect(await listEdges(conn, { relation: 'met_at_event' })).toEqual([]);
  });
});

describe('unlinkAttendee', () => {
  it('removes one attendance row and reports whether it existed', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    expect(await unlinkAttendee(conn, { eventId: event.id, contactId: 'a' })).toMatchObject({
      removed: true,
    });
    expect(await unlinkAttendee(conn, { eventId: event.id, contactId: 'a' })).toMatchObject({
      removed: false,
    });
    expect((await getEvent(conn, event.id))!.attendees).toEqual([]);
  });
});

describe('importEvents', () => {
  const file = [
    'name,location,starts_at,attendees',
    'React Conf,Berlin,2026-09-14,"ada@engines.dev; bob@builders.io; Zoe Zodiac"',
  ].join('\n');

  it('imports events, links matched attendees and keeps the rest for review', async () => {
    const summary = await importEvents(conn, { csv: file, now });
    expect(summary.events).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.matched).toBe(2);
    expect(summary.unmatched).toBe(1);
    expect(summary.attendees).toBe(2);
    expect(summary.edges).toBe(1);

    const detail = await getEvent(conn, (await resolveEventRef(conn, 'React Conf')).id);
    expect(detail!.attendees.map((a) => a.contactId)).toEqual(['a', 'b']);
    expect(detail!.unmatched).toEqual([{ name: 'Zoe Zodiac', email: null, reason: 'no contact matches "Zoe Zodiac"' }]);
  });

  it('lands imported co-attendee edges as pending — attendance is not a meeting', async () => {
    await importEvents(conn, { csv: file, now });
    const edges = await listEdges(conn, { relation: 'met_at_event' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.status).toBe('pending');
    expect(edges[0]!.source).toBe('event_import');
    expect(edges[0]!.confidence).toBe(1); // both matched by exact email
  });

  it('is idempotent — a second import writes nothing', async () => {
    const first = await importEvents(conn, { csv: file, now });
    const second = await importEvents(conn, { csv: file, now });
    expect(second.events).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    expect(second.attendees).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(second.edges).toBe(0);
    expect(first.attendees).toBe(2);
  });

  it('reports ambiguity instead of linking the wrong Sam', async () => {
    const summary = await importEvents(
      conn,
      { csv: csv(['name,attendees', 'Local Meetup,Sam Same']), now }
    );
    expect(summary.ambiguous).toBe(1);
    expect(summary.attendees).toBe(0);
    expect(summary.ambiguousRefs[0]!.candidates.map((c) => c.id)).toEqual(['dup1', 'dup2']);
  });

  it('leaves review-tier matches alone unless asked', async () => {
    const lines = ['name,names', 'Local Meetup,"A Lovelace"'].join('\n');
    const preview = await importEvents(conn, { csv: lines, now });
    expect(preview.review).toBe(1);
    expect(preview.attendees).toBe(0);
    expect(preview.unmatchedRefs).toHaveLength(1);

    const applied = await importEvents(conn, { csv: lines, now, includeReview: true });
    expect(applied.attendees).toBe(1);
    expect((await getEvent(conn, (await resolveEventRef(conn, 'Local Meetup')).id))!.attendees).toHaveLength(1);
  });

  it('never links a soft-deleted contact', async () => {
    const summary = await importEvents(
      conn,
      { csv: csv(['name,attendees', 'Ghost Meetup,ghost@example.com']), now }
    );
    expect(summary.unmatched).toBe(1);
    expect(summary.attendees).toBe(0);
  });

  it('previews without writing when dry-run', async () => {
    const summary = await importEvents(conn, { csv: file, now, dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.matched).toBe(2);
    expect(await countEvents(conn)).toBe(0);
    expect(await listEdges(conn, {})).toEqual([]);
  });

  it('carries parse errors through and still imports the good rows', async () => {
    const summary = await importEvents(
      conn,
      { csv: csv(['name,starts_at', 'Good,2026-09-14', 'Bad,whenever']), now }
    );
    expect(summary.created).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.row).toBe(3);
  });

  it('bounds pairwise edges and says it stopped', async () => {
    seed(
      Array.from({ length: 40 }, (_, i) => ({
        id: `p${i}`,
        fullName: `Person ${i}`,
        email: `p${i}@example.com`,
      }))
    );
    const attendees = Array.from({ length: 40 }, (_, i) => `p${i}@example.com`).join('; ');
    const summary = await importEvents(
      conn,
      { csv: csv(['name,attendees', `"Big Conf","${attendees}"`]), now }
    );
    expect(summary.attendees).toBe(40);
    expect(summary.edges).toBe(EVENT_LIMITS.edgesPerEvent);
    expect(summary.edgeCapReached).toBe(true);
  });

  it('accepts pre-parsed rows from the web layer', async () => {
    const summary = await importEvents(conn, {
      rows: [{ name: 'Hand Built', location: null, startsAt: null, endsAt: null, attendees: [{ email: 'ada@engines.dev' }] }],
      now,
    });
    expect(summary.attendees).toBe(1);
    expect(summary.errors).toEqual([]);
  });
});

describe('matchEventAttendees', () => {
  it('links the attendees that arrived after the import', async () => {
    await importEvents(conn, { csv: csv(['name,attendees', 'React Conf,zoe@zodiac.dev']), now });
    // Zoe joins the network after the file was imported.
    seed([{ id: 'z', fullName: 'Zoe Zodiac', email: 'zoe@zodiac.dev' }]);

    const preview = await matchEventAttendees(conn, 'React Conf', { now });
    expect(preview.matched).toBe(1);
    expect(preview.linked).toBe(0);
    expect(preview.applied).toBe(false);
    expect((await getEvent(conn, preview.event.id))!.attendees).toEqual([]);

    const applied = await matchEventAttendees(conn, 'React Conf', { now, apply: true });
    expect(applied.linked).toBe(1);
    expect((await getEvent(conn, preview.event.id))!.attendees.map((a) => a.contactId)).toEqual(['z']);
    expect((await getEvent(conn, preview.event.id))!.unmatched).toEqual([]);
  });

  it('keeps genuinely unresolvable lines in the bucket', async () => {
    await importEvents(conn, { csv: csv(['name,attendees', 'React Conf,nobody@nowhere.dev']), now });
    const result = await matchEventAttendees(conn, 'React Conf', { now, apply: true });
    expect(result.unmatched).toBe(1);
    expect(result.remaining).toHaveLength(1);
    expect((await getEvent(conn, result.event.id))!.unmatched).toHaveLength(1);
  });

  it('does nothing for an event with no bucket and no rows', async () => {
    const { event } = await upsertEvent(conn, { name: 'Empty Conf' }, { now });
    const result = await matchEventAttendees(conn, event.id, { now, apply: true });
    expect(result.matches).toEqual([]);
    expect(result.linked).toBe(0);
  });

  it('404s on an unknown event', async () => {
    await expect(matchEventAttendees(conn, 'nope', { now })).rejects.toThrow(/No event found/);
  });
});

describe('listEvents', () => {
  it('counts network attendees and orders newest first, undated last', async () => {
    await importEvents(
      conn,
      {
        csv: csv([
          'name,starts_at,attendees',
          'Old Conf,2025-01-01,ada@engines.dev',
          'New Conf,2026-01-01,"ada@engines.dev; bob@builders.io"',
          'Undated,,cara@chen.dev',
          'Empty Conf,2026-02-01,',
        ]),
        now,
      }
    );
    const { events, total } = await listEvents(conn, { limit: 10 });
    expect(total).toBe(4);
    expect(events.map((e) => e.name)).toEqual(['Empty Conf', 'New Conf', 'Old Conf', 'Undated']);
    expect(events.find((e) => e.name === 'New Conf')!.attendeeCount).toBe(2);
    expect(events.find((e) => e.name === 'Empty Conf')!.attendeeCount).toBe(0);
  });

  it('filters by name fragment and by upcoming', async () => {
    await importEvents(
      conn,
      {
        csv: csv([
          'name,starts_at',
          'React Conf,2026-10-01',
          'RustConf,2026-11-01',
          'Past Conf,2020-01-01',
        ]),
        now,
      }
    );
    const { events, total } = await listEvents(conn, { query: 'conf', limit: 10 });
    expect(total).toBe(3);
    expect(events.map((e) => e.name)).toEqual(['RustConf', 'React Conf', 'Past Conf']);

    const upcoming = await listEvents(conn, { upcoming: true, limit: 10, now });
    expect(upcoming.events.map((e) => e.name)).toEqual(['RustConf', 'React Conf']);
  });

  it('treats LIKE wildcards in the query as literal characters', async () => {
    await upsertEvent(conn, { name: '100% Conf' }, { now });
    await upsertEvent(conn, { name: 'Anything Goes' }, { now });
    const { events } = await listEvents(conn, { query: '100%', limit: 10 });
    expect(events.map((e) => e.name)).toEqual(['100% Conf']);
  });

  it('paginates', async () => {
    for (const name of ['A Conf', 'B Conf', 'C Conf']) await upsertEvent(conn, { name }, { now });
    const page = await listEvents(conn, { limit: 2, offset: 1 });
    expect(page.events.map((e) => e.name)).toEqual(['B Conf', 'C Conf']);
    expect(page.total).toBe(3);
  });
});

describe('getEvent', () => {
  it('renders the overlap: who was there, what they do', async () => {
    const { event } = await upsertEvent(conn, { name: 'Fintech Conf' }, { now });
    for (const id of ['a', 'b', 'c']) {
      await linkAttendee(conn, { eventId: event.id, contactId: id, via: 'manual', edges: false }, { now });
    }
    const detail = await getEvent(conn, event.id)!;
    expect(detail).toBeTruthy();
    expect(detail!.attendeeCount).toBe(3);
    // Strongest tie first.
    expect(detail!.attendees.map((a) => a.contactId)).toEqual(['a', 'b', 'c']);
    expect(detail!.industries).toEqual(['fintech', 'devtools']);
    expect(detail!.companies).toEqual(['Builders', 'Chen', 'Engines']);
  });

  it('returns null for an unknown id', async () => {
    expect(await getEvent(conn, 'nope')).toBeNull();
  });
});

describe('listContactEvents', () => {
  it('lists the events one contact attended, newest first', async () => {
    await importEvents(
      conn,
      {
        csv: csv([
          'name,starts_at,attendees',
          'Old Conf,2025-01-01,ada@engines.dev',
          'New Conf,2026-01-01,"ada@engines.dev; bob@builders.io"',
          'Skipped,cara@chen.dev',
        ]),
        now,
      }
    );
    const events = await listContactEvents(conn, 'a');
    expect(events.map((e) => e.name)).toEqual(['New Conf', 'Old Conf']);
    expect(events[0]!.attendeeCount).toBe(2);
    expect(await listContactEvents(conn, 'gone')).toEqual([]);
  });
});

describe('recommendEvents', () => {
  it('ranks by people × industry fit × timing and explains every score', async () => {
    await importEvents(
      conn,
      {
        csv: csv([
          'name,starts_at,attendees',
          // Two fintech peers, soon: the best suggestion.
          'Fintech Week,2026-10-01,"ada@engines.dev; bob@builders.io"',
          // One peer, long past.
          'Old Devtools Day,2020-01-01,cara@chen.dev',
          // Nobody you know, but upcoming — worth a look.
          'Stranger Conf,2026-09-20,',
        ]),
        now,
      }
    );
    const ranked = await recommendEvents(conn, { limit: 10, now });
    // People outrank recency: one peer at an old event beats zero peers at a
    // future one, because the recommendation is about who you already know.
    expect(ranked.map((r) => r.event.name)).toEqual(['Fintech Week', 'Old Devtools Day', 'Stranger Conf']);

    const top = ranked[0]!;
    // 0.6 × peers(2/5) + 0.2 × industry(fintech = 2 of 3) + 0.2 × timing(soon)
    expect(top.score).toBe(0.57);
    expect(top.reasons).toContain('2 people in your network');
    expect(top.reasons.some((r) => r.startsWith('industries (fintech) cover'))).toBe(true);
    expect(top.reasons.some((r) => r.startsWith('starts in'))).toBe(true);
    expect(top.attendees.map((a) => a.contactId)).toEqual(['a', 'b']);

    expect(ranked[1]!.reasons).toContain('1 person in your network');
    expect(ranked[1]!.reasons.some((r) => /^started (\d+ days|\d+ years) ago$/.test(r))).toBe(true);
    expect(ranked[1]!.score).toBeLessThan(top.score);
    expect(ranked[2]!.reasons).toContain('nobody from your network yet');
    expect(ranked[2]!.reasons.some((r) => r.startsWith('starts in'))).toBe(true);
  });

  it('drops empty past events instead of recommending them', async () => {
    await upsertEvent(conn, { name: 'Forgotten Conf', startsAt: '2019-01-01' }, { now });
    expect(await recommendEvents(conn, { now })).toEqual([]);
  });

  it('caps the list', async () => {
    for (const name of ['A', 'B', 'C']) await upsertEvent(conn, { name, startsAt: '2026-10-01' }, { now });
    expect(await recommendEvents(conn, { limit: 2, now })).toHaveLength(2);
  });
});

describe('removeEvent', () => {
  it('cascades attendance rows and reports the event it removed', async () => {
    const { event } = await upsertEvent(conn, { name: 'React Conf' }, { now });
    await linkAttendee(conn, { eventId: event.id, contactId: 'a' }, { now });
    const removed = await removeEvent(conn, event.id);
    expect(removed.name).toBe('React Conf');
    expect(await countEvents(conn)).toBe(0);
    expect(await listContactEvents(conn, 'a')).toEqual([]);
    await expect(removeEvent(conn, event.id)).rejects.toThrow(/No event with id/);
  });
});

describe('eventsStatus', () => {
  it('counts events, links, distinct attendees and covered events', async () => {
    await importEvents(
      conn,
      {
        csv: csv([
          'name,attendees',
          'React Conf,"ada@engines.dev; bob@builders.io"',
          'RustConf,ada@engines.dev',
          'Empty Conf,',
        ]),
        now,
      }
    );
    const status = await eventsStatus(conn);
    expect(status).toEqual({ events: 3, attendees: 2, links: 3, contacts: 5, withAttendees: 2 });
  });
});
