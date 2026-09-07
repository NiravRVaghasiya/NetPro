import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));
vi.mock('../panels', () => ({
  AddAttendeeForm: () => <div data-testid="add-attendee" />,
  MatchPanel: () => <div data-testid="match-panel" />,
  RemoveAttendeeButton: () => <button>Remove</button>,
  RemoveEventButton: () => <button>Delete event</button>,
  LinkUnmatchedForm: ({ label }: { label: string }) => <div data-testid="link-form">{label}</div>,
}));

import EventDetailPage from './page';

const NOW = new Date('2026-09-07T12:00:00.000Z').toISOString();

async function render(id: string): Promise<string> {
  const element = await EventDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

let eventId = '';

beforeEach(async () => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  for (const r of [
    { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', industry: 'fintech', relationshipScore: 0.9 },
    { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io', company: 'Builders', industry: 'devtools', relationshipScore: 0.6 },
    { id: 'gone', fullName: 'Ghost', email: 'ghost@example.com', deletedAt: NOW },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
  const { importEvents, resolveEventRef } = await import('@netpro/core/src/events');
  // A past event so attendance is "attended", not "planned".
  await importEvents(fixture.conn, {
    csv: [
      'name,location,starts_at,attendees',
      'React Conf,Berlin,2020-09-14,"ada@engines.dev; bob@builders.io; nobody@nowhere.dev"',
    ].join('\n'),
    now: new Date(NOW),
  });
  eventId = (await resolveEventRef(fixture.conn, 'React Conf')).id;
});
afterAll(() => fixture.sqlite.close());

describe('/events/[id] page', () => {
  it('renders the event, its dates and the overlap', async () => {
    const html = await render(eventId);
    expect(html).toContain('<h1>React Conf</h1>');
    expect(html).toContain('Berlin');
    expect(html).toContain('2020-09-14');
    // One of each, so the tie breaks alphabetically — deterministic output.
    expect(html).toContain('Industries: devtools, fintech');
    expect(html).toContain('Companies: Builders, Engines');
    expect(html).toContain('<strong>2</strong> in your network');
  });

  it('lists attendees strongest-tie first with their score and role', async () => {
    const html = await render(eventId);
    expect(html).toContain('href="/contacts/a"');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('0.90');
    expect(html.indexOf('Ada Lovelace')).toBeLessThan(html.indexOf('Bob Builder'));
    expect(html).toContain('attended');
  });

  it('shows the unmatched bucket with a per-row link form', async () => {
    const html = await render(eventId);
    expect(html).toContain('Unmatched attendees (1)');
    expect(html).toContain('nobody@nowhere.dev');
    expect(html).toContain('no contact matches');
    expect(html).toContain('link-form');
  });

  it('renders the panels and a warm-intro route into the graph', async () => {
    const html = await render(eventId);
    expect(html).toContain('add-attendee');
    expect(html).toContain('match-panel');
    expect(html).toContain('Delete event');
    expect(html).toContain(`href="/graph?target=a"`);
  });

  it('has an empty state and never lists a soft-deleted contact', async () => {
    fixture.sqlite.exec('DELETE FROM event_attendees;');
    const html = await render(eventId);
    expect(html).toContain('Nobody in your network is linked to this event yet');
    expect(html).not.toContain('Ghost');
  });

  it('resolves the event by name and 404s an unknown one', async () => {
    expect(await render('react conf')).toContain('<h1>React Conf</h1>');
    await expect(render('nope')).rejects.toThrow();
  });
});
