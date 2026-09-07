'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Request failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError('Network error — please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}

export function EdgeActions({ edgeId, status }: { edgeId: string; status: string }) {
  const { error, busy, run } = useAction();
  const url = `/api/edges/${encodeURIComponent(edgeId)}`;
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      {status === 'pending' && (
        <>
          <button type="button" disabled={busy} onClick={() => run(url, 'PATCH', { action: 'confirm' })}>
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => run(url, 'PATCH', { action: 'reject' })}>
            Reject
          </button>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => run(url, 'DELETE')}>
        Remove
      </button>
      {error && (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      )}
    </span>
  );
}

export function AddEdgeForm() {
  const { error, busy, run } = useAction();
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [relation, setRelation] = useState('manual');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run('/api/edges', 'POST', { sourceId, targetId, relation, status: 'confirmed' });
    if (ok) {
      setSourceId('');
      setTargetId('');
    }
  }

  return (
    <section aria-label="Add a manual edge" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Add a manual link</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '32rem' }}>
        <input
          required
          placeholder="From contact id"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        />
        <input
          required
          placeholder="To contact id"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        />
        <label>
          Relation{' '}
          <select value={relation} onChange={(e) => setRelation(e.target.value)}>
            {['manual', 'colleague', 'met_at_event', 'mutual_intro', 'mutual_network'].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Add edge'}
          </button>
        </div>
        {error && (
          <p role="alert" style={{ color: '#b91c1c', margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

export function MetAtEventPanel({ contactId }: { contactId: string }) {
  const { error, busy, run } = useAction();
  const [eventName, setEventName] = useState('');
  const [location, setLocation] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run('/api/edges', 'POST', {
      contactId,
      eventName,
      location: location || undefined,
    });
    if (ok) {
      setEventName('');
      setLocation('');
    }
  }

  return (
    <section aria-label="Also met at">
      <h2 style={{ fontSize: '1rem' }}>Also met at…</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '32rem' }}>
        <input
          required
          placeholder="Event name — e.g. React Conf"
          value={eventName}
          maxLength={200}
          onChange={(e) => setEventName(e.target.value)}
        />
        <input
          placeholder="Location (optional)"
          value={location}
          maxLength={200}
          onChange={(e) => setLocation(e.target.value)}
        />
        <div>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Record attendance'}
          </button>
        </div>
        {error && (
          <p role="alert" style={{ color: '#b91c1c', margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
