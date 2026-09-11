// apps/web/components/activity-feed.tsx
//
// Phase 8 — Activity feed that visualizes the NetPro event stream in real
// time. It subscribes via the `useNetProEvents` hook (SSE) and renders each
// event the plan lists — scan.progress, contact.imported, graph.updated, etc.
// — with the same visual language the Observatory uses (progress bars,
// timestamps, job links). The Web UI becomes an observatory, not a poller.
//
// This component is client-side (`'use client'`) because EventSource only
// exists in the browser. The server-rendered Activity page wraps it and
// handles the initial jobs list via fetch (so the page is not blank while
// the SSE connects).

'use client';

import { useMemo, useState } from 'react';
import { useNetProEvents, type NetProEvent } from '@/hooks/use-netpro-events';

function formatTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}

function eventLabel(type: string): string {
  const map: Record<string, string> = {
    'scan.started': 'Scan started',
    'scan.progress': 'Scanning',
    'scan.completed': 'Scan completed',
    'contact.imported': 'Contacts imported',
    'contact.updated': 'Contacts updated',
    'relationship.discovered': 'Relationship discovered',
    'relationship.updated': 'Relationship updated',
    'graph.updated': 'Graph updated',
    'search.started': 'Search started',
    'search.completed': 'Search done',
    'enrichment.started': 'Enrichment started',
    'enrichment.completed': 'Enrichment finished',
    'import.started': 'Import started',
    'import.progress': 'Importing',
    'import.completed': 'Import finished',
    'job.queued': 'Job queued',
    'job.running': 'Job running',
    'job.progress': 'Job progress',
    'job.completed': 'Job completed',
    'job.failed': 'Job failed',
    'job.cancelled': 'Job cancelled',
  };
  return map[type] ?? type;
}

function eventColor(type: string): string {
  if (type.endsWith('.failed') || type === 'job.failed') return '#dc2626';
  if (type.endsWith('.completed') || type === 'job.completed') return '#16a34a';
  if (type.includes('progress') || type.endsWith('.started') || type === 'job.running') return '#2563eb';
  if (type.startsWith('relationship') || type === 'graph.updated') return '#9333ea';
  if (type.startsWith('search')) return '#0d9488';
  return '#64748b';
}

function progressOf(e: NetProEvent): number | null {
  if (typeof e.progress === 'number' && Number.isFinite(e.progress)) return e.progress;
  return null;
}

export function ActivityFeed({
  serverUrl,
  initialEvents,
  types,
  jobId,
  maxItems = 80,
}: {
  serverUrl?: string;
  initialEvents?: NetProEvent[];
  types?: string[];
  jobId?: string;
  maxItems?: number;
}) {
  const { events: live, connected, error } = useNetProEvents({
    serverUrl,
    types,
    jobId,
    history: 20,
  });
  const [filter, setFilter] = useState<string>('');

  // Merge initial (SSR jobs or replay) + live, de-dup by seq, newest last.
  const all = useMemo(() => {
    const merged = [...(initialEvents ?? []), ...live];
    const bySeq = new Map<string, NetProEvent>();
    for (const e of merged) {
      const key = e.seq !== undefined ? `seq:${e.seq}` : `${e.type}:${e.jobId ?? ''}:${e.timestamp ?? ''}:${e.message ?? ''}`;
      bySeq.set(key, e);
    }
    const sorted = [...bySeq.values()].sort((a, b) => {
      const sa = a.seq ?? 0;
      const sb = b.seq ?? 0;
      if (sa !== sb) return sa - sb;
      const ta = a.timestamp ?? '';
      const tb = b.timestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return sorted.slice(-maxItems);
  }, [initialEvents, live, maxItems]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((e) => {
      const hay = `${e.type} ${e.message ?? ''} ${e.jobId ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [all, filter]);

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: '0.8rem',
            color: connected ? '#16a34a' : '#92400e',
            background: connected ? '#f0fdf4' : '#fffbeb',
            border: `1px solid ${connected ? '#bbf7d0' : '#fde68a'}`,
            borderRadius: 999,
            padding: '0.2rem 0.6rem',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: connected ? '#16a34a' : '#f59e0b',
              display: 'inline-block',
            }}
          />
          {connected ? 'Live — connected to NetPro server' : 'Connecting… (live updates via SSE)'}
        </span>
        {error ? <span style={{ color: '#dc2626', fontSize: '0.8rem' }}>{error}</span> : null}
        <input
          type="search"
          placeholder="Filter events…"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          aria-label="Filter events"
          style={{
            marginLeft: 'auto',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: '0.35rem 0.7rem',
            fontSize: '0.85rem',
            minWidth: 180,
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
          No events yet. Trigger an import, a scan, or a search — they appear here instantly, even when started from the CLI (`netpro
          scan`).
        </p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {filtered
            .slice()
            .reverse()
            .map((e, idx) => {
              const p = progressOf(e);
              return (
                <li
                  // Feed events carry seq when present; the reversed index
                  // only disambiguates same-type events without one.
                  key={`${e.seq ?? e.type}-${idx}`}
                  style={{
                    display: 'flex',
                    gap: '0.75rem',
                    alignItems: 'flex-start',
                    padding: '0.6rem 0',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: eventColor(e.type),
                      marginTop: 6,
                      flexShrink: 0,
                    }}
                    aria-hidden
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '0.9rem' }}>{eventLabel(e.type)}</strong>
                      <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>{e.type}</span>
                      {e.jobId ? (
                        <span style={{ color: '#6b7280', fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace' }}>
                          {e.jobId.slice(0, 8)}
                        </span>
                      ) : null}
                      <span style={{ color: '#9ca3af', fontSize: '0.75rem', marginLeft: 'auto' }}>
                        {formatTime(e.timestamp)}
                      </span>
                    </div>
                    {e.message ? <div style={{ color: '#374151', fontSize: '0.9rem', marginTop: 2 }}>{String(e.message)}</div> : null}
                    {e.error ? <div style={{ color: '#dc2626', fontSize: '0.85rem', marginTop: 2 }}>{String(e.error)}</div> : null}
                    {p !== null ? (
                      <div
                        style={{
                          marginTop: 6,
                          height: 6,
                          background: '#f3f4f6',
                          borderRadius: 999,
                          overflow: 'hidden',
                          maxWidth: 320,
                        }}
                      >
                        <div
                          style={{
                            height: 6,
                            width: `${Math.max(0, Math.min(100, p))}%`,
                            background: eventColor(e.type),
                            borderRadius: 999,
                            transition: 'width 0.4s ease',
                          }}
                        />
                      </div>
                    ) : null}
                    {e.imported !== undefined || e.merged !== undefined ? (
                      <div style={{ color: '#6b7280', fontSize: '0.8rem', marginTop: 4 }}>
                        {e.imported !== undefined ? `imported ${e.imported}` : ''}
                        {e.merged !== undefined ? ` · merged ${e.merged}` : ''}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
        </ol>
      )}
    </div>
  );
}
