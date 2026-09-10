// apps/web/components/observatory.tsx
//
// Phase 9/10 — Observatory: the primary dashboard for the local-first NetPro
// (Phase 10 describes it; Phase 9 provides the foundation it renders on).
//
// What it shows (from the plan):
//   Network size, Relationships, Communities, Recent activity, Current jobs,
//   Last scan, Enrichment status, Index status, Graph status.
//
// Where the data comes from:
//   * Server-fetched: /api/analytics, /api/graph, /api/jobs (via @/lib/netpro-server)
//   * Live:          /api/events  (SSE — scan.progress, import.completed, …)
//
// The component is server-agnostic: when the server is unreachable it renders
// the same shape from the direct-DB fallback the legacy dashboard uses, but
// with a banner that names the server URL so the operator knows why the
// "Live" dot is amber. The Web UI never duplicates core logic — it visualizes
// what the server's core already computed.

import Link from 'next/link';

export type ObservatoryStats = {
  contacts: number;
  relationships?: number;
  communities?: number;
  jobs?: { total: number; running: number; queued: number };
  graph?: { nodes: number; edges: number; components: number };
  lastScan?: string | null;
  enrichmentConfigured?: boolean;
  indexContacts?: number;
};

const CARD: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '0.9rem 1rem',
  minWidth: 140,
  background: 'white',
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={CARD}>
      <div style={{ fontSize: '0.75rem', color: '#6b7280', letterSpacing: '0.02em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      {hint ? <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

export function ObservatoryGrid({ stats, serverUrl, serverReachable }: { stats: ObservatoryStats; serverUrl: string; serverReachable: boolean }) {
  return (
    <div>
      {!serverReachable ? (
        <div
          style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            color: '#92400e',
            borderRadius: 10,
            padding: '0.6rem 0.9rem',
            marginBottom: '1rem',
            fontSize: '0.9rem',
          }}
        >
          NetPro server not reachable at <code>{serverUrl}</code>. Run{' '}
          <code style={{ background: '#fff', padding: '0.1rem 0.3rem', borderRadius: 4 }}>netpro serve</code> to enable live updates. Showing
          local data instead.
        </div>
      ) : (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            color: '#14532d',
            borderRadius: 10,
            padding: '0.5rem 0.9rem',
            marginBottom: '1rem',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span
            aria-hidden
            style={{ width: 8, height: 8, borderRadius: 999, background: '#16a34a', display: 'inline-block' }}
          />
          Connected to NetPro server at <code>{serverUrl}</code> — live updates enabled.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
        <Metric label="Contacts" value={String(stats.contacts)} hint="Network size" />
        <Metric
          label="Relationships"
          value={stats.relationships !== undefined ? String(stats.relationships) : '—'}
          hint={stats.relationships !== undefined ? 'confirmed edges' : 'via /api/graph'}
        />
        <Metric
          label="Communities"
          value={stats.communities !== undefined ? String(stats.communities) : '—'}
          hint={stats.communities !== undefined ? 'Louvain modules' : 'via /api/graph'}
        />
        <Metric
          label="Active jobs"
          value={stats.jobs ? String(stats.jobs.running + stats.jobs.queued) : '—'}
          hint={stats.jobs ? `${stats.jobs.running} running · ${stats.jobs.queued} queued` : 'via /api/jobs'}
        />
      </div>

      <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', marginTop: '0.85rem' }}>
        <div style={{ ...CARD, flex: '1 1 260px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Graph</div>
          {stats.graph ? (
            <div style={{ fontSize: '0.9rem', color: '#374151', marginTop: 4 }}>
              {stats.graph.nodes} nodes · {stats.graph.edges} edges · {stats.graph.components} components
              <div style={{ marginTop: 6 }}>
                <Link href="/network" style={{ color: '#2563eb', fontSize: '0.85rem' }}>
                  Explore network →
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: '0.9rem', marginTop: 4 }}>
              No confirmed edges yet. <Link href="/import" style={{ color: '#2563eb' }}>Import a CSV</Link> or{' '}
              <Link href="/edges" style={{ color: '#2563eb' }}>add links</Link>.
            </div>
          )}
        </div>
        <div style={{ ...CARD, flex: '1 1 260px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Enrichment & index</div>
          <div style={{ fontSize: '0.9rem', color: '#374151', marginTop: 4 }}>
            <div>Enrichment: {stats.enrichmentConfigured ? <span style={{ color: '#16a34a' }}>● configured</span> : <span style={{ color: '#9ca3af' }}>● not configured</span>}</div>
            <div>Search index: {stats.indexContacts !== undefined ? `${stats.indexContacts} contacts` : '—'}</div>
            <div style={{ marginTop: 6, display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
              <Link href="/search" style={{ color: '#2563eb', fontSize: '0.85rem' }}>
                Search →
              </Link>
              <Link href="/settings" style={{ color: '#2563eb', fontSize: '0.85rem' }}>
                Provider status →
              </Link>
            </div>
          </div>
        </div>
        <div style={{ ...CARD, flex: '1 1 260px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>What to do next</div>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', fontSize: '0.9rem', color: '#374151' }}>
            <li>
              <Link href="/people" style={{ color: '#2563eb' }}>
                Browse people
              </Link>{' '}
              — your CRM, now server-backed.
            </li>
            <li>
              <Link href="/activity" style={{ color: '#2563eb' }}>
                Open Activity
              </Link>{' '}
              — watch imports & scans live.
            </li>
            <li>
              <code>netpro import</code> or <Link href="/import" style={{ color: '#2563eb' }}>upload a CSV</Link>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
