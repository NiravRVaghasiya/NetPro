'use client';

// Mutation panels for the contact detail page. Reads stay server-rendered;
// these small client components POST/PATCH the CRM API routes and then
// `router.refresh()` so the server components re-read fresh data — the same
// pattern as the outreach composer and card editor.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const INTERACTION_TYPES = [
  'meeting',
  'call',
  'note',
  'email_sent',
  'email_received',
  'linkedin_message',
  'intro_made',
] as const;

const CHANNELS = ['', 'email', 'linkedin', 'twitter', 'in_person', 'phone', 'other'] as const;
const DIRECTIONS = ['', 'inbound', 'outbound'] as const;

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(url: string, method: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  return { error, busy, run, setError };
}

/** A date-only input value as a UTC ISO timestamp at the given hour. */
function dateToIso(value: string, hour: number): string | undefined {
  if (!value) return undefined;
  return `${value}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

export function LogInteractionPanel({ contactId }: { contactId: string }) {
  const { error, busy, run } = useAction();
  const [type, setType] = useState<string>('note');
  const [channel, setChannel] = useState<string>('');
  const [direction, setDirection] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [occurredOn, setOccurredOn] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run('/api/interactions', 'POST', {
      contactId,
      type,
      channel: channel || undefined,
      direction: direction || undefined,
      subject: subject || undefined,
      content: content || undefined,
      // A date-only backdate means midday UTC — never a future "tomorrow"
      // for users west of Greenwich, never rejected by the +1 day bound.
      occurredAt: dateToIso(occurredOn, 12),
    });
    if (ok) {
      setSubject('');
      setContent('');
      setOccurredOn('');
    }
  }

  return (
    <section aria-label="Log an interaction">
      <h2 style={{ fontSize: '1rem' }}>Log an interaction</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '32rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label>
            Type{' '}
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {INTERACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Channel{' '}
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c === '' ? '—' : c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Direction{' '}
            <select value={direction} onChange={(e) => setDirection(e.target.value)}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d === '' ? 'auto' : d}
                </option>
              ))}
            </select>
          </label>
          <label>
            When{' '}
            <input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          </label>
        </div>
        <input
          placeholder="Subject (optional)"
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
        />
        <textarea
          placeholder="What happened? (notes, summary…)"
          value={content}
          rows={3}
          maxLength={5000}
          onChange={(e) => setContent(e.target.value)}
        />
        <div>
          <button type="submit" disabled={busy}>
            {busy ? 'Logging…' : 'Log interaction'}
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

export function AddFollowUpPanel({ contactId }: { contactId: string }) {
  const { error, busy, run, setError } = useAction();
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Due-in days must be a positive number.');
      return;
    }
    const ok = await run('/api/follow-ups', 'POST', {
      contactId,
      dueInMs: Math.round(n * 24 * 60 * 60 * 1000),
      reason: reason || undefined,
      recurrenceRule: recurrenceRule || undefined,
    });
    if (ok) {
      setReason('');
    }
  }

  return (
    <section aria-label="Schedule a follow-up">
      <h2 style={{ fontSize: '1rem' }}>Schedule a follow-up</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '32rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label>
            Due in (days){' '}
            <input
              type="number"
              min="1"
              step="1"
              value={days}
              style={{ width: '5rem' }}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <label>
            Repeat{' '}
            <select value={recurrenceRule} onChange={(e) => setRecurrenceRule(e.target.value)}>
              <option value="">never</option>
              <option value="7d">weekly</option>
              <option value="30d">every 30 days</option>
              <option value="90d">every 90 days</option>
            </select>
          </label>
        </div>
        <input
          placeholder="Reason (optional) — e.g. “Send the deck”"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <div>
          <button type="submit" disabled={busy}>
            {busy ? 'Scheduling…' : 'Schedule follow-up'}
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

export function FollowUpActions({ followUpId }: { followUpId: string }) {
  const { error, busy, run } = useAction();
  const url = `/api/follow-ups/${encodeURIComponent(followUpId)}`;
  const DAY = 24 * 60 * 60 * 1000;

  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <button type="button" disabled={busy} onClick={() => run(url, 'PATCH', { action: 'complete' })}>
        Complete
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(url, 'PATCH', { action: 'snooze', forMs: 3 * DAY })}
      >
        Snooze 3d
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(url, 'PATCH', { action: 'snooze', forMs: 7 * DAY })}
      >
        Snooze 7d
      </button>
      <button type="button" disabled={busy} onClick={() => run(url, 'PATCH', { action: 'cancel' })}>
        Cancel
      </button>
      {error && (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      )}
    </span>
  );
}
