'use client';

// Client panels for the campaigns pages. Reads stay server-rendered; these
// POST/PATCH the /api/campaigns routes and then `router.refresh()` (or navigate
// to the new campaign) — the same pattern as the contact-detail panels and the
// outreach composer.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(url: string, method: string, body: unknown): Promise<unknown | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; campaign?: { id: string } }
        | null;
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status}).`);
        return null;
      }
      router.refresh();
      return data;
    } catch {
      setError('Network error — please try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { error, busy, run, setError };
}

const inputStyle = { padding: '0.5rem', width: '100%' } as const;

interface StepDraft {
  delayDays: string;
  subject: string;
  body: string;
}

/** Create-a-campaign form: single message or drip sequence, plus recipients. */
export function CampaignCreatePanel() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendFrom, setSendFrom] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [recipientMode, setRecipientMode] = useState<'search' | 'ids' | 'none'>('search');
  const [search, setSearch] = useState({ query: '', company: '', role: '', location: '', industry: '' });
  const [ids, setIds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addStep() {
    setSteps((prev) => [...prev, { delayDays: '3', subject: '', body: '' }]);
  }
  function updateStep(i: number, patch: Partial<StepDraft>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const contactIds = ids
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const searchFilter = Object.fromEntries(
        Object.entries(search).filter(([, v]) => v.trim().length > 0)
      );
      let recipients: { contactIds?: string[]; search?: Record<string, string> } | undefined;
      if (recipientMode === 'ids' && contactIds.length > 0) {
        recipients = { contactIds };
      } else if (recipientMode === 'search' && Object.keys(searchFilter).length > 0) {
        recipients = { search: searchFilter };
      }

      const payload = {
        name,
        template: { subject, body },
        steps: steps.map((s) => ({
          delayDays: Number(s.delayDays),
          subject: s.subject,
          body: s.body,
        })),
        sendFrom: sendFrom.trim() || undefined,
        dailyLimit: dailyLimit.trim() ? Number(dailyLimit) : undefined,
        recipients,
      };

      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; campaign?: { id: string } }
        | null;
      if (!res.ok || !data?.campaign) {
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      router.push(`/outreach/campaigns/${data.campaign.id}`);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1rem', maxWidth: 720 }}>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <input
          placeholder="Campaign name (e.g. “Q3 reactivation”)"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          aria-label="Campaign name"
          style={inputStyle}
        />
        <input
          placeholder="Subject — merge vars allowed, e.g. “Hi {{firstName}}”"
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Message subject"
          style={inputStyle}
        />
        <textarea
          placeholder="Message body — personalize with {{firstName}}, {{company}}, {{role}}…"
          value={body}
          maxLength={5000}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Message body"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <input
          placeholder="Send from (your mailbox — advisory)"
          value={sendFrom}
          onChange={(e) => setSendFrom(e.target.value)}
          aria-label="Send from"
          style={inputStyle}
        />
        <input
          placeholder="Daily limit (default 50)"
          value={dailyLimit}
          inputMode="numeric"
          onChange={(e) => setDailyLimit(e.target.value)}
          aria-label="Daily limit"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Drip steps</strong>
          <button type="button" onClick={addStep} disabled={steps.length >= 5}>
            + Add step
          </button>
        </div>
        {steps.length === 0 && (
          <p style={{ margin: 0, color: '#777', fontSize: '0.85rem' }}>
            No steps — this is a single-message campaign. Add up to 5 follow-up messages.
          </p>
        )}
        {steps.map((s, i) => (
          <div
            key={i}
            style={{ border: '1px solid hsl(var(--border))', borderRadius: 8, padding: '0.75rem', display: 'grid', gap: '0.5rem' }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                After
                <input
                  value={s.delayDays}
                  inputMode="numeric"
                  onChange={(e) => updateStep(i, { delayDays: e.target.value })}
                  aria-label={`Step ${i + 1} delay in days`}
                  style={{ ...inputStyle, width: '4rem' }}
                />
                days
              </label>
              <button type="button" onClick={() => removeStep(i)} style={{ marginLeft: 'auto' }}>
                Remove
              </button>
            </div>
            <input
              placeholder="Step subject"
              value={s.subject}
              maxLength={200}
              onChange={(e) => updateStep(i, { subject: e.target.value })}
              aria-label={`Step ${i + 1} subject`}
              style={inputStyle}
            />
            <textarea
              placeholder="Step body"
              value={s.body}
              maxLength={5000}
              rows={2}
              onChange={(e) => updateStep(i, { body: e.target.value })}
              aria-label={`Step ${i + 1} body`}
              style={inputStyle}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <strong>Recipients</strong>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['search', 'ids', 'none'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setRecipientMode(m)}
              style={{ fontWeight: recipientMode === m ? 700 : 400 }}
            >
              {m === 'search' ? 'From a search' : m === 'ids' ? 'By contact id' : 'Add later'}
            </button>
          ))}
        </div>
        {recipientMode === 'search' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <input placeholder="Full-text query" value={search.query} onChange={(e) => setSearch({ ...search, query: e.target.value })} style={inputStyle} />
            <input placeholder="Company" value={search.company} onChange={(e) => setSearch({ ...search, company: e.target.value })} style={inputStyle} />
            <input placeholder="Role" value={search.role} onChange={(e) => setSearch({ ...search, role: e.target.value })} style={inputStyle} />
            <input placeholder="Location" value={search.location} onChange={(e) => setSearch({ ...search, location: e.target.value })} style={inputStyle} />
            <input placeholder="Industry" value={search.industry} onChange={(e) => setSearch({ ...search, industry: e.target.value })} style={inputStyle} />
          </div>
        )}
        {recipientMode === 'ids' && (
          <textarea
            placeholder="Contact ids, comma or newline separated"
            value={ids}
            rows={3}
            onChange={(e) => setIds(e.target.value)}
            aria-label="Recipient contact ids"
            style={inputStyle}
          />
        )}
        {recipientMode === 'none' && (
          <p style={{ margin: 0, color: '#777', fontSize: '0.85rem' }}>
            Create the draft now; add recipients later from the campaign page.
          </p>
        )}
      </div>

      <div>
        <button type="button" onClick={() => void submit()} disabled={busy || !name.trim() || !subject.trim() || !body.trim()}>
          {busy ? 'Creating…' : 'Create draft campaign'}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      )}
    </div>
  );
}

const NEXT_STATUS: Record<string, { label: string; status: string }[]> = {
  draft: [{ label: 'Activate', status: 'active' }, { label: 'Archive', status: 'archived' }],
  active: [{ label: 'Pause', status: 'paused' }, { label: 'Complete', status: 'completed' }, { label: 'Archive', status: 'archived' }],
  paused: [{ label: 'Resume', status: 'active' }, { label: 'Complete', status: 'completed' }, { label: 'Archive', status: 'archived' }],
  completed: [{ label: 'Archive', status: 'archived' }],
  archived: [],
};

/** Lifecycle transition buttons for one campaign. */
export function CampaignStatusActions({ campaignId, status }: { campaignId: string; status: string }) {
  const { error, busy, run } = useAction();
  const moves = NEXT_STATUS[status] ?? [];
  if (moves.length === 0 && !error) return null;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
      {moves.map((m) => (
        <button
          key={m.status}
          type="button"
          disabled={busy}
          onClick={() => void run(`/api/campaigns/${campaignId}`, 'PATCH', { action: 'status', status: m.status })}
        >
          {m.label}
        </button>
      ))}
      {error && (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Per-recipient send/reply/skip actions on the campaign detail page. */
export function RecipientActions({
  campaignId,
  recipientId,
  status,
}: {
  campaignId: string;
  recipientId: string;
  status: string;
}) {
  const { error, busy, run } = useAction();
  const url = `/api/campaigns/${campaignId}/recipients/${recipientId}`;
  const canSend = status === 'pending' || status === 'scheduled';
  const canReply = status === 'sent' || status === 'scheduled';
  const canSkip = status === 'pending' || status === 'scheduled';
  if (!canSend && !canReply && !canSkip) {
    return error ? (
      <span role="alert" style={{ color: '#b91c1c' }}>{error}</span>
    ) : (
      <span style={{ color: '#777', fontSize: '0.85rem' }}>done</span>
    );
  }
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
      {canSend && (
        <button type="button" disabled={busy} onClick={() => void run(url, 'POST', { action: 'sent' })}>
          Mark sent
        </button>
      )}
      {canReply && (
        <button type="button" disabled={busy} onClick={() => void run(url, 'POST', { action: 'replied' })}>
          Got reply
        </button>
      )}
      {canSkip && (
        <button type="button" disabled={busy} onClick={() => void run(url, 'POST', { action: 'skipped' })}>
          Skip
        </button>
      )}
      {error && (
        <span role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </span>
      )}
    </div>
  );
}
