import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeEventsAdd,
  executeEventsImport,
  executeEventsLink,
  executeEventsList,
  executeEventsMatch,
  executeEventsRecommend,
  executeEventsRm,
  executeEventsShow,
  executeEventsUnlink,
  renderEventDetail,
  renderImportSummary,
  renderMatchResult,
  renderRecommendations,
} from './events';
import { createProgram } from '../cli';

const fixture = createTestSqliteConn();
const conn = fixture.conn;
const now = new Date('2026-09-07T12:00:00Z');
const NOW = now.toISOString();

const dir = join(tmpdir(), `netpro-events-test-${process.pid}`);
mkdirSync(dir, { recursive: true });
const csvPath = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
};

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  const rows = [
    { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', industry: 'fintech', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', company: 'Builders', industry: 'fintech', relationshipScore: 0.6 },
    { id: 'z', fullName: 'Zoe Zodiac', email: 'zoe@zodiac.dev', company: 'Zodiac', relationshipScore: 0.4 },
  ];
  for (const r of rows) {
    conn.db
      .insert(conn.schema.contacts)
      .values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

const EVENTS_CSV = [
  'name,location,starts_at,attendees',
  'React Conf,Berlin,2026-09-14,"ada@engines.dev; bob@builders.io; nobody@nowhere.dev"',
].join('\n');

describe('netpro events registration', () => {
  it('is the seventeenth command with the documented subcommands', () => {
    const program = createProgram();
    expect(program.commands.map((c) => c.name())).toContain('events');
    const events = program.commands.find((c) => c.name() === 'events')!;
    expect(events.commands.map((c) => c.name())).toEqual([
      'list',
      'show',
      'add',
      'import',
      'match',
      'link',
      'unlink',
      'recommend',
      'rm',
    ]);
  });
});

describe('events list', () => {
  it('renders counts, dates and an empty state', async () => {
    expect(await executeEventsList({}, conn, now)).toContain('No events yet');

    await executeEventsImport(csvPath('list.csv', EVENTS_CSV), {}, conn, now);
    const out = await executeEventsList({}, conn, now);
    expect(out).toContain('Events (1 of 1):');
    expect(out).toContain('React Conf · Berlin');
    expect(out).toContain('2026-09-14 (in 7d)');
    expect(out).toContain('2 in your network');
    expect(out).toContain('2 attendance row(s) across 1 event(s).');
  });

  it('filters with --query and --upcoming', async () => {
    await executeEventsImport(csvPath('two.csv', 'name,starts_at\nReact Conf,2026-10-01\nRustConf,2020-01-01'), {}, conn, now);
    expect(await executeEventsList({ query: 'react' }, conn, now)).toContain('React Conf');
    expect(await executeEventsList({ query: 'react' }, conn, now)).not.toContain('RustConf');
    const upcoming = await executeEventsList({ upcoming: true }, conn, now);
    expect(upcoming).toContain('React Conf');
    expect(upcoming).not.toContain('RustConf');
  });

  it('rejects a nonsense --limit', async () => {
    await expect(executeEventsList({ limit: 'lots' }, conn, now)).rejects.toThrow(/--limit/);
  });

  it('emits JSON with --json', async () => {
    await executeEventsImport(csvPath('json.csv', EVENTS_CSV), {}, conn, now);
    const parsed = JSON.parse(await executeEventsList({ json: true }, conn, now));
    expect(parsed.total).toBe(1);
    expect(parsed.events[0].attendeeCount).toBe(2);
  });
});

describe('events add / show', () => {
  it('adds an event and reports a repeat as already existing', async () => {
    const added = await executeEventsAdd('React Conf', { starts: '2026-09-14' }, conn, now);
    expect(added).toContain('✓ Added React Conf');
    expect(await executeEventsAdd('react conf', {}, conn, now)).toContain('already exists');
  });

  it('shows the overlap, industries and unmatched bucket', async () => {
    await executeEventsImport(csvPath('show.csv', EVENTS_CSV), {}, conn, now);
    const out = await executeEventsShow('React Conf', {}, conn, now);
    expect(out).toContain('React Conf');
    expect(out).toContain('In your network (2):');
    expect(out).toContain('Ada Lovelace — Engines');
    expect(out).toContain('Industries: fintech');
    expect(out).toContain('Unmatched attendees (1)');
    expect(out).toContain('nobody@nowhere.dev');
    expect(out).toContain('netpro events link');
  });

  it('404s on an unknown event', async () => {
    await expect(executeEventsShow('nope', {}, conn, now)).rejects.toThrow(/No event found/);
  });
});

describe('events import', () => {
  it('reports matched, unmatched and the pending edges it wrote', async () => {
    const out = await executeEventsImport(csvPath('import.csv', EVENTS_CSV), {}, conn, now);
    expect(out).toContain('✓ Imported 1 event(s) (1 new, 0 already known)');
    expect(out).toContain('matched: 2');
    expect(out).toContain('unmatched: 1');
    expect(out).toContain('1 met_at_event edge(s) written as pending');
  });

  it('honours --dry-run', async () => {
    const out = await executeEventsImport(csvPath('dry.csv', EVENTS_CSV), { dryRun: true }, conn, now);
    expect(out).toContain('Preview — nothing written');
    expect(await executeEventsList({}, conn, now)).toContain('No events yet');
  });

  it('reports ambiguity with the candidate ids', async () => {
    conn.db
      .insert(conn.schema.contacts)
      .values({ id: 'a2', fullName: 'Ada Lovelace', email: 'ada2@engines.dev', source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
    const out = await executeEventsImport(csvPath('amb.csv', 'name,names\nMeetup,Ada Lovelace'), {}, conn, now);
    expect(out).toContain('ambiguous: 1');
    expect(out).toContain('matches Ada Lovelace [a], Ada Lovelace [a2]');
  });

  it('surfaces parse errors without losing the good rows', async () => {
    const out = await executeEventsImport(
      csvPath('bad.csv', 'name,starts_at\nGood,2026-09-14\nBad,whenever'),
      {},
      conn,
      now
    );
    expect(out).toContain('✓ Imported 1 event(s)');
    expect(out).toContain('row 3: "whenever" is not a date');
  });

  it('renders the edge-cap warning when a big event blows the budget', () => {
    const summary = {
      events: 1, created: 1, existing: 0, attendees: 40, duplicates: 0,
      matched: 40, review: 0, ambiguous: 0, unmatched: 0, edges: 250,
      edgeCapReached: true, errors: [], warnings: [], unmatchedRefs: [], ambiguousRefs: [], dryRun: false,
    };
    expect(renderImportSummary(summary)).toContain('⚠ hit the per-event edge cap');
  });
});

describe('events match', () => {
  it('previews first and links only with --apply', async () => {
    // nobody@nowhere.dev is not in the network yet, so it lands in the bucket.
    await executeEventsImport(csvPath('m1.csv', 'name,attendees\nReact Conf,nobody@nowhere.dev'), {}, conn, now);
    expect(await executeEventsMatch('React Conf', {}, conn, now)).toContain('0 attendee(s) would link');

    conn.db
      .insert(conn.schema.contacts)
      .values({ id: 'n', fullName: 'Nova Nowhere', email: 'nobody@nowhere.dev', source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();

    const preview = await executeEventsMatch('React Conf', {}, conn, now);
    expect(preview).toContain('1 attendee(s) would link');
    expect(preview).toContain('(dry run — add --apply)');

    const applied = await executeEventsMatch('React Conf', { apply: true }, conn, now);
    expect(applied).toContain('linked 1 attendee(s)');
    expect(await executeEventsShow('React Conf', {}, conn, now)).toContain('Nova Nowhere');
  });

  it('renders a review tier it did not link', () => {
    const out = renderMatchResult({
      event: { id: 'e1', name: 'Conf', location: null, startsAt: null, endsAt: null, source: 'manual', createdAt: NOW },
      matched: 0, review: 1, ambiguous: 1, unmatched: 1, linked: 0, duplicates: 0, edges: 0,
      edgeCapReached: false,
      matches: [
        { ref: { name: 'A Lovelace' }, status: 'review', contactId: 'a', confidence: 0.6, via: 'initials', candidates: [], reason: 'confirm' },
        { ref: { name: 'Sam Same' }, status: 'ambiguous', contactId: null, confidence: 0.9, via: 'name', candidates: [], reason: '2 contacts match' },
        { ref: { name: 'Nobody' }, status: 'unmatched', contactId: null, confidence: 0, via: null, candidates: [], reason: 'no contact matches' },
      ],
      remaining: [],
      applied: false,
    });
    expect(out).toContain('needs review: 1 (add --review to include)');
    expect(out).toContain('ambiguous: 1');
    expect(out).toContain('unmatched: 1');
    expect(out).toContain('review    A Lovelace');
  });
});

describe('events link / unlink', () => {
  it('links a contact by selector and unlinks them again', async () => {
    const { event } = await importCreated();
    expect(await executeEventsLink(event.id, 'Ada Lovelace', {}, conn, now)).toContain(
      '✓ Linked Ada Lovelace → React Conf'
    );
    expect(await executeEventsLink(event.id, 'ada@engines.dev', {}, conn, now)).toContain('Already linked');
    expect(await executeEventsUnlink(event.id, 'Ada Lovelace', {}, conn)).toContain('✗ Removed');
    expect(await executeEventsUnlink(event.id, 'Ada Lovelace', {}, conn)).toContain('was not linked');
  });

  it('creates a confirmed edge to someone already on the event', async () => {
    const { event } = await importCreated();
    await executeEventsLink(event.id, 'Ada Lovelace', {}, conn, now);
    const out = await executeEventsLink(event.id, 'Bob Builder', {}, conn, now);
    expect(out).toContain('1 confirmed met_at_event edge(s)');
  });

  it('errors on an unknown contact', async () => {
    const { event } = await importCreated();
    await expect(executeEventsLink(event.id, 'Nobody At All', {}, conn, now)).rejects.toThrow(/No contact/);
  });

  async function importCreated() {
    const { upsertEvent } = await import('@netpro/core/src/events');
    return upsertEvent(conn, { name: 'React Conf' }, { now });
  }
});

describe('events recommend', () => {
  it('ranks events and explains every score', async () => {
    await executeEventsImport(csvPath('rec.csv', EVENTS_CSV), {}, conn, now);
    const out = await executeEventsRecommend({}, conn, now);
    expect(out).toContain('Recommended events (1):');
    expect(out).toContain('React Conf');
    expect(out).toContain('2 people in your network');
    expect(out).toContain('going: Ada Lovelace, Bob Builder');
  });

  it('has an empty state', async () => {
    expect(await executeEventsRecommend({}, conn, now)).toContain('No events to recommend yet');
  });
});

describe('events rm', () => {
  it('removes an event and its attendance rows', async () => {
    await executeEventsImport(csvPath('rm.csv', EVENTS_CSV), {}, conn, now);
    const out = await executeEventsRm('React Conf', {}, conn);
    expect(out).toContain('✗ Removed React Conf');
    expect(await executeEventsList({}, conn, now)).toContain('No events yet');
    await expect(executeEventsRm('React Conf', {}, conn)).rejects.toThrow(/No event found/);
  });
});

describe('render helpers', () => {
  it('render a detail and a recommendation without throwing on sparse data', () => {
    const detail = {
      event: { id: 'e1', name: 'Bare', location: null, startsAt: null, endsAt: null, source: 'manual', createdAt: NOW },
      attendees: [],
      attendeeCount: 0,
      industries: [],
      companies: [],
      unmatched: [],
    };
    expect(renderEventDetail(detail, now)).toContain('Nobody in your network is linked to this event yet.');
    expect(renderRecommendations([], now)).toContain('No events to recommend yet');
  });
});

