'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react';

interface WebhookItem {
  id: string;
  workspaceId: string;
  url: string;
  secret: string; // masked in list
  eventAllowlist: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryItem {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  status: string;
  receivedAt: string | null;
  responseCode: number | null;
  errorMessage: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  initialWebhooks: WebhookItem[];
  workspaceId: string;
  role: string;
}

const ALL_EVENTS = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'interaction.logged',
  'followup.created',
  'followup.completed',
  'followup.updated',
  'campaign.created',
  'campaign.activated',
  'campaign.step.confirmed',
  'campaign.recipient.replied',
  'content.added',
  'content.updated',
  'plugin.enabled',
  'plugin.disabled',
  'workspace.member.added',
  'workspace.member.removed',
  'workspace.member.role_changed',
];

export default function WebhooksClient({ initialWebhooks }: Props) {
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [eventsDraft, setEventsDraft] = useState<string[]>([
    'contact.created',
    'interaction.logged',
    'followup.completed',
    'campaign.activated',
    'content.added',
    'workspace.member.added',
  ]);
  const [secretOnce, setSecretOnce] = useState<{ id: string; secret: string } | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, DeliveryItem[]>>({});
  const [recipes, setRecipes] = useState<any>(null);

  async function refresh() {
    const res = await fetch('/api/webhooks');
    if (res.ok) {
      const data = await res.json();
      setWebhooks(data);
    }
  }

  useEffect(() => {
    fetch('/api/webhooks/events')
      .then((r) => r.json())
      .then((d) => setRecipes(d.recipes))
      .catch(() => {});
  }, []);

  async function addWebhook() {
    if (!urlDraft.trim()) {
      setError('URL is required');
      return;
    }
    setLoading('add');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlDraft.trim(), events: eventsDraft, status: 'enabled' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to add webhook');
      } else {
        setSecretOnce({ id: data.id, secret: data.secret });
        setNotice(`Created ${data.id} — secret shown once below. Save it for signature verification.`);
        setUrlDraft('');
        await refresh();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function deleteWebhook(id: string) {
    if (!confirm(`Delete webhook ${id}? This also deletes its delivery history.`)) return;
    setLoading(`${id}:delete`);
    setError(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Delete failed');
      else {
        setNotice(`Deleted ${id}`);
        await refresh();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function toggleStatus(id: string, status: string) {
    setLoading(`${id}:status`);
    setError(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Update failed');
      else await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function rotateSecret(id: string) {
    if (!confirm(`Rotate secret for ${id}? Old signatures will stop verifying.`)) return;
    setLoading(`${id}:rotate`);
    setError(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Rotate failed');
      else {
        setSecretOnce({ id: data.id, secret: data.secret });
        setNotice(`Rotated secret for ${data.id} — new secret shown once below.`);
        await refresh();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function loadDeliveries(webhookId: string) {
    setLoading(`${webhookId}:deliveries`);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(webhookId)}/deliveries?limit=20`);
      const data = await res.json();
      if (res.ok) setDeliveries((prev) => ({ ...prev, [webhookId]: data }));
      else setError(data.error || 'Could not load deliveries');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function testWebhook(webhookId: string) {
    setLoading(`${webhookId}:test`);
    setError(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(webhookId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'contact.created' }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Test failed');
      else {
        const d = data.delivery;
        setNotice(d ? `Test delivery ${d.id}: ${d.status} HTTP ${d.responseCode ?? ''}` : 'Test emitted but no delivery (check status/allowlist)');
        await loadDeliveries(webhookId);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function redeliver(deliveryId: string, webhookId: string) {
    setLoading(`${deliveryId}:redeliver`);
    try {
      const res = await fetch(`/api/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redeliver`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Redeliver failed');
      else {
        setNotice(`Redelivered ${data.id}: ${data.status}`);
        await loadDeliveries(webhookId);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  function toggleEvent(ev: string) {
    setEventsDraft((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));
  }

  return (
    <div>
      {error && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 rounded bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
      {secretOnce && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="font-semibold text-amber-900">Secret for {secretOnce.id} — shown once</div>
          <code className="mt-1 block break-all rounded bg-white p-2 text-xs">{secretOnce.secret}</code>
          <div className="mt-1 text-xs text-amber-700">Store it securely. Verification header: X-NetPro-Signature: t=unix,v1=HMAC-SHA256(secret, t.payload)</div>
          <button onClick={() => setSecretOnce(null)} className="mt-2 rounded bg-slate-100 px-2 py-1 text-xs">Dismiss</button>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold">Add webhook</h2>
        <div className="mt-3">
          <input
            className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
            placeholder="https://hooks.zapier.com/..."
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-slate-400">Private-network URLs (localhost, 10.x, 192.168.x) are allowed but flagged — useful for self-hosted n8n.</div>
        </div>
        <div className="mt-3">
          <div className="text-xs font-medium">Events</div>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {ALL_EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={eventsDraft.includes(ev)} onChange={() => toggleEvent(ev)} />
                {ev}
              </label>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">{eventsDraft.length} selected — empty means all in API but UI requires at least one.</div>
        </div>
        <button
          disabled={!!loading}
          onClick={addWebhook}
          className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {loading === 'add' ? '...' : 'Add webhook'}
        </button>
      </div>

      <div className="mt-8 space-y-4">
        {webhooks.length === 0 ? (
          <div className="rounded-xl border border-slate-200 p-6 text-sm text-slate-500">No webhooks yet. Add one above.</div>
        ) : (
          webhooks.map((wh) => (
            <div key={wh.id} className="rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-sm font-semibold">{wh.id}</div>
                  <div className="text-sm">{wh.url}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {wh.status} · events: {wh.eventAllowlist.length ? wh.eventAllowlist.join(', ') : '(all)'} · created {wh.createdAt}
                  </div>
                </div>
                <div className="flex gap-2">
                  {wh.status === 'enabled' ? (
                    <button disabled={!!loading} onClick={() => toggleStatus(wh.id, 'disabled')} className="rounded bg-slate-100 px-2 py-1 text-xs">
                      Disable
                    </button>
                  ) : (
                    <button disabled={!!loading} onClick={() => toggleStatus(wh.id, 'enabled')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">
                      Enable
                    </button>
                  )}
                  <button disabled={!!loading} onClick={() => testWebhook(wh.id)} className="rounded bg-slate-100 px-2 py-1 text-xs">
                    {loading === `${wh.id}:test` ? '...' : 'Test'}
                  </button>
                  <button disabled={!!loading} onClick={() => rotateSecret(wh.id)} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    Rotate secret
                  </button>
                  <button disabled={!!loading} onClick={() => deleteWebhook(wh.id)} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button disabled={!!loading} onClick={() => loadDeliveries(wh.id)} className="rounded bg-slate-100 px-2 py-1 text-xs">
                  {loading === `${wh.id}:deliveries` ? '...' : 'Load deliveries'}
                </button>
              </div>
              {deliveries[wh.id] && deliveries[wh.id]!.length >= 0 && (
                <div className="mt-3 rounded border border-slate-100 p-3">
                  <div className="text-xs font-medium">Recent deliveries ({deliveries[wh.id]!.length})</div>
                  <div className="mt-2 space-y-1">
                    {deliveries[wh.id]!.map((d) => (
                      <div key={d.id} className="flex items-center justify-between text-xs">
                        <span>
                          {d.createdAt.slice(0, 19)} {d.event} {d.status} {d.responseCode ? `HTTP ${d.responseCode}` : ''} attempt {d.attempt}/{d.maxAttempts}
                          {d.errorMessage && <span className="ml-2 text-red-600">{d.errorMessage.slice(0, 200)}</span>}
                        </span>
                        {(d.status === 'failed' || d.status === 'pending') && (
                          <button disabled={!!loading} onClick={() => redeliver(d.id, wh.id)} className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-[11px]">
                            Redeliver
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {recipes && (
        <div className="mt-10 rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold">Receiver recipes</h2>
          <p className="mt-1 text-xs text-slate-500">Signature header: X-NetPro-Signature = t=unix,v1=HMAC-SHA256(secret, t.payload). Verify with constant-time compare and 5m replay window.</p>
          <div className="mt-3 space-y-4">
            {Object.entries(recipes).map(([key, rec]: any) => (
              <div key={key} className="text-xs">
                <div className="font-medium">{rec.name}</div>
                {rec.steps && <ul className="mt-1 list-disc pl-4 text-slate-600">{rec.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>}
                {rec.code && <pre className="mt-1 overflow-auto rounded bg-slate-50 p-2 text-[11px]">{rec.code}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
