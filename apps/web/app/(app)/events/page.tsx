// apps/web/app/(app)/events/page.tsx
//
// v2.0 Phase 6 — the event matcher. Server-rendered and GET-form driven, the
// house pattern: every number comes from the same core functions the CLI uses,
// and the analysis is offline (no provider, no key, no network).
//
//   * the list — every event with how many of your contacts attended;
//   * the recommendations — ranked by people × industry fit × timing, with the
//     reasons for each score printed next to it.
import Link from 'next/link';
import { conn } from '@/lib/db';
import {
  eventsStatus,
  listEvents,
  recommendEvents,
  type EventRecommendation,
  type EventSummary,
} from '@netpro/core/src/events';
import { dueLabel, scoreLabel } from '@/lib/format';
import { eventListParams } from '@/lib/events-request';
import { AddEventForm, ImportEventsPanel } from './panels';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

function when(startsAt: string | null, endsAt: string | null, now: Date): string {
  if (!startsAt) return 'no date';
  return endsAt && endsAt.slice(0, 10) !== startsAt.slice(0, 10)
    ? `${dueLabel(startsAt, now)} → ${endsAt.slice(0, 10)}`
    : dueLabel(startsAt, now);
}

function Recommendations({ rows, now }: { rows: EventRecommendation[]; now: Date }) {
  if (rows.length === 0) return null;
  return (
    <section style={{ marginTop: '1.75rem' }}>
      <h2>Where to go next</h2>
      <p style={{ color: '#6b7280' }}>
        Ranked 0.6 × how many of your contacts went, 0.2 × how much of your network shares their
        industries, 0.2 × timing. Every score is explained underneath.
      </p>
      <ol style={{ paddingLeft: '1.25rem' }}>
        {rows.map((r) => (
          <li key={r.event.id} style={{ marginBottom: '0.6rem' }}>
            <Link href={`/events/${encodeURIComponent(r.event.id)}`}>{r.event.name}</Link>{' '}
            <strong>{r.score.toFixed(2)}</strong> · {when(r.event.startsAt, r.event.endsAt, now)}
            <div style={{ color: '#374151', fontSize: '0.875rem' }}>{r.reasons.join(' · ')}</div>
            {r.attendees.length > 0 ? (
              <div style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                going:{' '}
                {r.attendees.map((a, i) => (
                  <span key={a.contactId}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/contacts/${encodeURIComponent(a.contactId)}`}>{a.fullName}</Link>
                    <span> ({scoreLabel(a.relationshipScore)})</span>
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function EventTable({ events }: { events: EventSummary[] }) {
  if (events.length === 0) {
    return (
      <p style={{ color: '#9ca3af' }}>
        No events yet. Add one below, or import a CSV of events and attendees — NetPro matches the
        attendee list against your contacts for you.
      </p>
    );
  }
  return (
    <table data-testid="events-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
          <th style={{ padding: '0.4rem 0.5rem' }}>Event</th>
          <th style={{ padding: '0.4rem 0.5rem' }}>When</th>
          <th style={{ padding: '0.4rem 0.5rem' }}>Where</th>
          <th style={{ padding: '0.4rem 0.5rem' }}>In your network</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
            <td style={{ padding: '0.4rem 0.5rem' }}>
              <Link href={`/events/${encodeURIComponent(e.id)}`}>{e.name}</Link>
            </td>
            <td style={{ padding: '0.4rem 0.5rem', color: '#374151' }}>{when(e.startsAt, e.endsAt, new Date())}</td>
            <td style={{ padding: '0.4rem 0.5rem', color: '#6b7280' }}>{e.location ?? '—'}</td>
            <td style={{ padding: '0.4rem 0.5rem' }}>
              {e.attendeeCount === 0 ? (
                <span style={{ color: '#9ca3af' }}>nobody yet</span>
              ) : (
                <strong>{e.attendeeCount}</strong>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const q = await searchParams;
  const sp = new URLSearchParams();
  const query = one(q.query);
  const upcoming = q.upcoming === '1' || q.upcoming === 'true';
  if (query) sp.set('query', query);
  if (upcoming) sp.set('upcoming', '1');

  const now = new Date();
  const [{ events, total }, recommendations, status] = await Promise.all([
    listEvents(conn, { ...eventListParams(sp), limit: 100 }),
    recommendEvents(conn, { limit: 5, now }),
    eventsStatus(conn),
  ]);

  return (
    <div>
      <h1>Events</h1>
      <p style={{ color: '#475569' }}>
        Who in your network was at a conference, and which one you should go to next. Import an
        attendee list and NetPro matches it against your contacts — by email, then by name, never by
        guessing. <Link href="/graph">Warm intros</Link> · <Link href="/edges">Edges</Link>
      </p>
      <p style={{ color: '#6b7280' }}>
        {status.events} event{status.events === 1 ? '' : 's'} · {status.links} attendance row
        {status.links === 1 ? '' : 's'} · {status.attendees} of {status.contacts} contacts have been
        somewhere.
      </p>

      <form
        method="get"
        action="/events"
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', margin: '1rem 0' }}
      >
        <input
          name="query"
          defaultValue={query ?? ''}
          placeholder="Filter by name"
          maxLength={200}
          style={{ padding: '0.4rem' }}
        />
        <label style={{ fontSize: '0.875rem' }}>
          <input type="checkbox" name="upcoming" value="1" defaultChecked={upcoming} /> upcoming only
        </label>
        <button type="submit">Filter</button>
        {query || upcoming ? <Link href="/events">Clear</Link> : null}
      </form>

      {events.length < total ? (
        <p style={{ color: '#6b7280' }}>
          Showing {events.length} of {total}.
        </p>
      ) : null}

      <EventTable events={events} />
      <Recommendations rows={recommendations} now={now} />
      <AddEventForm />
      <ImportEventsPanel />
    </div>
  );
}
