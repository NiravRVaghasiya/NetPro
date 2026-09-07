'use client';

// apps/web/app/(app)/events/panels.tsx
//
// The interactive pieces of /events and /events/[id]. Every mutation goes
// through the owner-only APIs; nothing here holds a key, a connection string,
// or contact data it did not render. Two ideas show up in all four panels:
//
//   * **Preview before write.** The CSV import and the re-match both default to
//     a dry run, because an attendee list is a claim about *your* network that
//     you should get to look at first.
//   * **Ambiguity is surfaced, not resolved.** Rows the matcher could not
//     decide on come back in the payload and are rendered as decisions for the
//     owner, never silently linked.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(
    url: string,
    method: string,
    body?: unknown
  ): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const message = data && typeof data.error === 'string' ? data.error : `Request failed (${res.status}).`;
        setError(message);
        return { ok: false, data };
      }
      router.refresh();
      return { ok: true, data };
    } catch {
      setError('Network error — please try again.');
      return { ok: false, data: null };
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, setError };
}

const field: React.CSSProperties = { display: 'grid', gap: '0.25rem', marginBottom: '0.5rem' };

export function AddEventForm() {
  const { error, busy, run } = useAction();
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run('/api/events', 'POST', { name, location, startsAt, endsAt });
    if (ok.ok) {
      setName('');
      setLocation('');
      setStartsAt('');
      setEndsAt('');
    }
  }

  return (
    <section aria-label="Add an event" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Add an event</h2>
      <form onSubmit={submit} style={{ maxWidth: '32rem' }}>
        <label style={field}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Name</span>
          <input required value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="React Conf" />
        </label>
        <label style={field}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Location (optional)</span>
          <input value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} placeholder="Berlin" />
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <label style={{ ...field, flex: 1 }}>
            <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Starts (YYYY-MM-DD)</span>
            <input value={startsAt} onChange={(e) => setStartsAt(e.target.value)} placeholder="2026-09-14" />
          </label>
          <label style={{ ...field, flex: 1 }}>
            <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Ends (optional)</span>
            <input value={endsAt} onChange={(e) => setEndsAt(e.target.value)} placeholder="2026-09-16" />
          </label>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add event'}
        </button>
        {error ? (
          <p role="alert" style={{ color: '#b91c1c', margin: '0.5rem 0 0' }}>
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

interface ImportSummary {
  events: number;
  created: number;
  existing: number;
  attendees: number;
  duplicates: number;
  matched: number;
  review: number;
  ambiguous: number;
  unmatched: number;
  edges: number;
  edgeCapReached: boolean;
  errors: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; reason: string }>;
  unmatchedRefs: Array<{ name: string | null; email: string | null; reason: string }>;
  ambiguousRefs: Array<{ event: string; ref: { email?: string | null; name?: string | null }; candidates: Array<{ id: string; fullName: string }> }>;
  dryRun: boolean;
}

export function ImportEventsPanel() {
  const { error, busy, run, setError } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function submit(event: React.FormEvent, dryRun: boolean) {
    event.preventDefault();
    if (!file) {
      setError('Choose a CSV file first.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const { ok, data } = await run(`/api/events?dryRun=${dryRun ? '1' : '0'}`, 'POST', form);
    setSummary(ok ? ((data as unknown as ImportSummary) ?? null) : null);
    if (ok) setError(null);
  }

  return (
    <section aria-label="Import events" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Import a CSV</h2>
      <p style={{ color: '#6b7280', margin: '0 0 0.5rem' }}>
        Columns are matched by name — <code>name</code>, <code>location</code>, <code>starts_at</code>,{' '}
        <code>ends_at</code> and an attendee list (<code>attendees</code>, <code>emails</code>,{' '}
        <code>names</code>…). Attendees are matched by email, then by name; anything ambiguous is left
        for you to decide.
      </p>
      <form style={{ maxWidth: '32rem' }}>
        <label style={field}>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" disabled={busy || !file} onClick={(e) => submit(e, true)}>
            {busy ? 'Working…' : 'Preview'}
          </button>
          <button type="button" disabled={busy || !file} onClick={(e) => submit(e, false)}>
            {busy ? 'Working…' : 'Import'}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      ) : null}
      {summary ? (
        <div style={{ marginTop: '0.75rem', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem' }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            <strong>{summary.dryRun ? 'Preview — nothing written.' : 'Imported.'}</strong>{' '}
            {summary.events} event(s) · {summary.matched} matched · {summary.review} needs review ·{' '}
            {summary.ambiguous} ambiguous · {summary.unmatched} unmatched
            {summary.dryRun ? null : ` · ${summary.attendees} row(s) written`}
          </p>
          {summary.edges > 0 ? (
            <p style={{ color: '#b45309', margin: '0 0 0.25rem' }}>
              {summary.edges} <code>met_at_event</code> edge(s) written as <strong>pending</strong> — an
              attendee list is evidence of attendance, not of a meeting. Confirm the ones you believe on{' '}
              <a href="/edges?status=pending">Edges</a>.
            </p>
          ) : null}
          {summary.edgeCapReached ? (
            <p style={{ color: '#b45309', margin: '0 0 0.25rem' }}>
              Hit the per-event edge cap — some co-attendee links were skipped.
            </p>
          ) : null}
          {summary.ambiguousRefs.length > 0 ? (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
              {summary.ambiguousRefs.slice(0, 5).map((a, i) => (
                <li key={`${a.ref.email ?? a.ref.name}-${i}`}>
                  {a.ref.email ?? a.ref.name} ({a.event}) could be{' '}
                  {a.candidates.map((c) => c.fullName).join(', ')}
                </li>
              ))}
            </ul>
          ) : null}
          {summary.errors.length > 0 ? (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
              {summary.errors.slice(0, 5).map((e) => (
                <li key={`${e.row}-${e.reason}`}>
                  row {e.row}: {e.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function RemoveEventButton({ eventId }: { eventId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm('Delete this event and its attendance rows?')) return;
          const { ok } = await run(`/api/events/${encodeURIComponent(eventId)}`, 'DELETE');
          if (ok) window.location.assign('/events');
        }}
      >
        {busy ? 'Deleting…' : 'Delete event'}
      </button>
      {error ? (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function AddAttendeeForm({ eventId }: { eventId: string }) {
  const { error, busy, run } = useAction();
  const [contact, setContact] = useState('');
  const [role, setRole] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { ok } = await run(`/api/events/${encodeURIComponent(eventId)}/attendees`, 'POST', {
      contact,
      role: role || undefined,
    });
    if (ok) {
      setContact('');
      setRole('');
    }
  }

  return (
    <section aria-label="Add an attendee" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Add someone from your network</h2>
      <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', maxWidth: '36rem' }}>
        <input
          required
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="name, email or id"
          style={{ flex: '2 1 14rem' }}
        />
        <input
          value={role}
          maxLength={80}
          onChange={(e) => setRole(e.target.value)}
          placeholder="role (speaker, sponsor…)"
          style={{ flex: '1 1 10rem' }}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Linking…' : 'Link attendee'}
        </button>
      </form>
      {error ? (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function RemoveAttendeeButton({ eventId, contactId }: { eventId: string; contactId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(
            `/api/events/${encodeURIComponent(eventId)}/attendees?contactId=${encodeURIComponent(contactId)}`,
            'DELETE'
          )
        }
      >
        {busy ? '…' : 'Remove'}
      </button>
      {error ? (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** One unresolved attendee line → a box where the owner names the contact. */
export function LinkUnmatchedForm({ eventId, label }: { eventId: string; label: string }) {
  const { error, busy, run } = useAction();
  const [contact, setContact] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { ok } = await run(`/api/events/${encodeURIComponent(eventId)}/attendees`, 'POST', { contact });
    if (ok) setContact('');
  }

  return (
    <form onSubmit={submit} style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
      <input
        required
        aria-label={`Link ${label} to a contact`}
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="name, email or id"
        style={{ width: '12rem' }}
      />
      <button type="submit" disabled={busy}>
        Link
      </button>
      {error ? (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

interface MatchPayload {
  matched: number;
  review: number;
  ambiguous: number;
  unmatched: number;
  linked: number;
  duplicates: number;
  edges: number;
  edgeCapReached: boolean;
  applied: boolean;
  matches: Array<{ status: string; ref: { email?: string | null; name?: string | null }; reason: string }>;
}

export function MatchPanel({ eventId }: { eventId: string }) {
  const { error, busy, run } = useAction();
  const [result, setResult] = useState<MatchPayload | null>(null);

  async function submit(apply: boolean) {
    const { ok, data } = await run(`/api/events/${encodeURIComponent(eventId)}/match`, 'POST', { apply });
    setResult(ok ? ((data as unknown as MatchPayload) ?? null) : null);
  }

  return (
    <section aria-label="Re-check attendees" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Re-check unresolved attendees</h2>
      <p style={{ color: '#6b7280', margin: '0 0 0.5rem' }}>
        Match the attendee lines that did not resolve against your network as it is now — useful after
        importing new contacts.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" disabled={busy} onClick={() => submit(false)}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button type="button" disabled={busy} onClick={() => submit(true)}>
          {busy ? 'Working…' : 'Link matches'}
        </button>
      </div>
      {error ? (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      ) : null}
      {result ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            {result.applied
              ? `Linked ${result.linked}${result.duplicates > 0 ? ` (${result.duplicates} already linked)` : ''}.`
              : `${result.matched} would link (preview).`}{' '}
            review {result.review} · ambiguous {result.ambiguous} · unmatched {result.unmatched}
            {result.edgeCapReached ? ' · ⚠ edge cap reached' : ''}
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {result.matches.slice(0, 10).map((m, i) => (
              <li key={`${m.ref.email ?? m.ref.name}-${i}`}>
                <strong>{m.status}</strong> {m.ref.email ?? m.ref.name ?? '(blank)'}
                {m.reason ? ` — ${m.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
