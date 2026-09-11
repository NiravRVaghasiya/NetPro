// apps/web/components/observatory.tsx
//
// Phase 10 — Observatory: the primary dashboard for the local-first NetPro.
//
// From the plan (Phase 10):
//   Show: Network size, Relationships, Communities, Recent activity, Current
//   jobs, Last scan, Enrichment status, Index status, Graph status.
//
// Where the data comes from:
//   * Server-fetched: /api/analytics, /api/graph, /api/jobs, /api/providers (via @/lib/netpro-server)
//   * Live:          /api/events  (SSE — scan.progress, import.completed, …)
//
// The component is server-agnostic: when the server is unreachable it renders
// the same shape from the direct-DB fallback, with a banner naming the server
// URL. The Web UI never duplicates core logic — it visualizes what the
// server's core already computed (Louvain, centrality, pathfinder, scoring).

import Link from 'next/link';

type ObservatoryJob = {
  id: string;
  type: string;
  status: string;
  progress: number;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type ObservatoryStats = {
  contacts: number;
  relationships?: number;
  communities?: number;
  modularity?: number;
  jobs?: { total: number; running: number; queued: number; list?: ObservatoryJob[] };
  graph?: {
    nodes: number;
    edges: number;
    components: number;
    largestComponent?: number;
    coverage?: number;
    avgPathLength?: number | null;
    degraded?: { reason: string } | null;
    pendingCandidates?: number;
  };
  lastScan?: { id: string; status: string; progress: number; completedAt: string | null; updatedAt?: string } | null;
  enrichment?: { configured: boolean; hunter: boolean; pdl: boolean; clearbit: boolean };
  embeddings?: { configured: boolean };
  ai?: { configured: boolean };
  indexContacts?: number;
  generatedAt?: string;
};

const CARD: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '0.9rem 1rem',
  minWidth: 140,
  background: 'white',
};

const SMALL_LABEL: React.CSSProperties = {
  fontSize: '0.7rem',
  color: '#6b7280',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

function Metric({ label, value, hint, sub }: { label: string; value: string; hint?: string; sub?: string }) {
  return (
    <div style={CARD}>
      <div style={SMALL_LABEL}>{label}</div>
      <div style={{ fontSize: '1.65rem', fontWeight: 750, lineHeight: 1.05, marginTop: 4, letterSpacing: '-0.02em' }}>{value}</div>
      {hint ? <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: 2 }}>{hint}</div> : null}
      {sub ? <div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function ProgressBar({ value, color = '#2563eb' }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div style={{ height: 8, background: '#f3f4f6', borderRadius: 999, overflow: 'hidden', flex: 1 }}>
      <div
        style={{
          height: 8,
          width: `${pct}%`,
          background: color,
          borderRadius: 999,
          transition: 'width 0.5s ease',
        }}
      />
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return <> just now</>;
    if (diff < 3600_000) return <>{Math.floor(diff / 60000)}m ago</>;
    if (diff < 86400_000) return <>{Math.floor(diff / 3600000)}h ago</>;
    if (diff < 604800000) return <>{Math.floor(diff / 86400000)}d ago</>;
    return <>{d.toLocaleDateString()}</>;
  } catch {
    return <>{iso.slice(0, 10)}</>;
  }
}

export function ObservatoryGrid({
  stats,
  serverUrl,
  serverReachable,
}: {
  stats: ObservatoryStats;
  serverUrl: string;
  serverReachable: boolean;
}) {
  const activeJobs = stats.jobs?.list?.filter((j) => j.status === 'running' || j.status === 'queued') ?? [];
  const lastScan = stats.lastScan;
  const hasGraph = (stats.graph?.nodes ?? 0) > 0;
  const graphDegraded = stats.graph?.degraded;

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
            flexWrap: 'wrap',
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: '#16a34a', display: 'inline-block' }} />
          Connected to NetPro server at <code>{serverUrl}</code> — live updates enabled.
          {stats.generatedAt ? <span style={{ color: '#6b7280' }}>· updated <RelativeTime iso={stats.generatedAt} /></span> : null}
        </div>
      )}

      {/* ┌────────────────────────────────────────────┐
          │  Plan mockup: Contacts  Relationships  Communities │
          └────────────────────────────────────────────┘ */}
      <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
        <Metric
          label="Contacts"
          value={String(stats.contacts)}
          hint="Network size"
          sub={stats.graph?.coverage !== undefined ? `${Math.round(stats.graph.coverage * 100)}% have edges` : undefined}
        />
        <Metric
          label="Relationships"
          value={stats.relationships !== undefined ? String(stats.relationships) : '—'}
          hint={stats.relationships !== undefined ? 'confirmed edges' : 'via /api/graph'}
          sub={
            stats.graph
              ? `${stats.graph.nodes} nodes · ${stats.graph.edges} edges`
              : undefined
          }
        />
        <Metric
          label="Communities"
          value={stats.communities !== undefined ? String(stats.communities) : '—'}
          hint={stats.communities !== undefined ? `Louvain${stats.modularity !== undefined ? ` · mod ${stats.modularity}` : ''}` : 'via /api/graph'}
          sub={stats.graph?.components !== undefined ? `${stats.graph.components} components · largest ${stats.graph.largestComponent ?? '—'}` : undefined}
        />
        <Metric
          label="Active jobs"
          value={stats.jobs ? String(stats.jobs.running + stats.jobs.queued) : '—'}
          hint={stats.jobs ? `${stats.jobs.running} running · ${stats.jobs.queued} queued · ${stats.jobs.total} total` : 'via /api/jobs'}
          sub={lastScan ? `last scan: ${lastScan.status} ${lastScan.progress}%` : 'no scan yet'}
        />
      </div>

      {/* Current Activity — the plan's central progress bar */}
      <div style={{ ...CARD, marginTop: '0.85rem', padding: '0.9rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>Current activity</div>
          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
            Live from the server&apos;s event stream (SSE) — imports, scans, and enrichments appear here whether triggered from the Web UI or CLI.
          </span>
          <Link href="/activity" style={{ marginLeft: 'auto', color: '#2563eb', fontSize: '0.8rem' }}>
            Open Activity →
          </Link>
        </div>
        {activeJobs.length > 0 ? (
          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.65rem' }}>
            {activeJobs.slice(0, 3).map((j) => (
              <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: j.status === 'running' ? '#2563eb' : '#92400e',
                    background: j.status === 'running' ? '#eff6ff' : '#fffbeb',
                    border: `1px solid ${j.status === 'running' ? '#dbeafe' : '#fde68a'}`,
                    borderRadius: 999,
                    padding: '0.15rem 0.5rem',
                  }}
                >
                  {j.type}
                </span>
                <span style={{ fontSize: '0.85rem', color: '#374151', flex: '0 1 auto' }}>
                  {String(j.metadata?.stage ?? j.status ?? '')}
                  {j.metadata && typeof j.metadata.message === 'string' ? ` — ${String(j.metadata.message)}` : ''}
                </span>
                <span style={{ fontSize: '0.75rem', color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>{j.id.slice(0, 8)}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto', minWidth: 180, flex: '1 1 180px' }}>
                  <ProgressBar value={j.progress ?? 0} color={j.status === 'running' ? '#2563eb' : '#f59e0b'} />
                  <span style={{ fontSize: '0.8rem', color: '#374151', fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>{j.progress ?? 0}%</span>
                </div>
              </div>
            ))}
            {activeJobs.length > 3 ? (
              <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>+{activeJobs.length - 3} more queued — <Link href="/activity" style={{ color: '#2563eb' }}>view all</Link></div>
            ) : null}
          </div>
        ) : (
          <div
            style={{
              marginTop: '0.7rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              color: '#6b7280',
              fontSize: '0.85rem',
              background: '#f9fafb',
              border: '1px dashed #e5e7eb',
              borderRadius: 10,
              padding: '0.6rem 0.85rem',
            }}
          >
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: '#9ca3af', display: 'inline-block' }} />
            Idle — no jobs running. Start a scan, import, or enrichment and it shows here instantly.
          </div>
        )}
      </div>

      {/* Four small status strips: Graph, Last scan, Enrichment & Index */}
      <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', marginTop: '0.85rem' }}>
        {/* Graph status */}
        <div style={{ ...CARD, flex: '1 1 260px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 650 }}>Graph status</div>
          {graphDegraded ? (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '0.5rem 0.7rem', marginTop: 8, color: '#92400e', fontSize: '0.84rem' }}>
              {graphDegraded.reason}
            </div>
          ) : hasGraph ? (
            <div style={{ fontSize: '0.9rem', color: '#374151', marginTop: 6, lineHeight: 1.45 }}>
              <div>
                {stats.graph!.nodes} nodes · {stats.graph!.edges} edges · {stats.graph!.components} components
                {stats.graph!.largestComponent ? ` · largest ${stats.graph!.largestComponent}` : ''}
              </div>
              <div style={{ color: '#6b7280', fontSize: '0.82rem' }}>
                {stats.graph!.avgPathLength !== undefined
                  ? stats.graph!.avgPathLength !== null
                    ? `avg path ${stats.graph!.avgPathLength} hops`
                    : 'avg path —'
                  : null}
                {stats.graph!.pendingCandidates ? ` · ${stats.graph!.pendingCandidates} pending` : ''}
                {stats.modularity !== undefined ? ` · modularity ${stats.modularity}` : ''}
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Link href="/network" style={{ color: '#fff', background: '#111827', borderRadius: 8, padding: '0.35rem 0.7rem', textDecoration: 'none', fontSize: '0.82rem' }}>
                  Explore network →
                </Link>
                <Link href="/graph" style={{ color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.35rem 0.7rem', textDecoration: 'none', fontSize: '0.82rem' }}>
                  Pathfinder
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: '0.9rem', marginTop: 6 }}>
              No confirmed edges yet. <Link href="/import" style={{ color: '#2563eb' }}>Import a CSV</Link> or{' '}
              <Link href="/edges" style={{ color: '#2563eb' }}>add links</Link>.
              <div style={{ marginTop: 8 }}>
                <Link href="/network" style={{ color: '#2563eb', fontSize: '0.84rem' }}>Network empty — create your first edge →</Link>
              </div>
            </div>
          )}
        </div>

        {/* Last scan & activity summary */}
        <div style={{ ...CARD, flex: '1 1 240px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 650 }}>Last scan</div>
          {lastScan ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: lastScan.status === 'completed' ? '#16a34a' : lastScan.status === 'running' ? '#2563eb' : lastScan.status === 'failed' ? '#dc2626' : '#6b7280',
                    background: lastScan.status === 'completed' ? '#f0fdf4' : lastScan.status === 'running' ? '#eff6ff' : lastScan.status === 'failed' ? '#fef2f2' : '#f9fafb',
                    border: `1px solid ${lastScan.status === 'completed' ? '#bbf7d0' : lastScan.status === 'running' ? '#dbeafe' : lastScan.status === 'failed' ? '#fecaca' : '#e5e7eb'}`,
                    borderRadius: 999,
                    padding: '0.2rem 0.55rem',
                  }}
                >
                  {lastScan.status}
                </span>
                <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>
                  {lastScan.completedAt ? <><RelativeTime iso={lastScan.completedAt} /></> : lastScan.updatedAt ? <><RelativeTime iso={lastScan.updatedAt} /></> : null}
                </span>
                <span style={{ fontSize: '0.75rem', color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>{lastScan.id.slice(0, 8)}</span>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <ProgressBar value={lastScan.progress ?? 0} color={lastScan.status === 'completed' ? '#16a34a' : lastScan.status === 'failed' ? '#dc2626' : '#2563eb'} />
                <span style={{ fontSize: '0.82rem', color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{lastScan.progress ?? 0}%</span>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Link
                  href="/activity"
                  style={{ fontSize: '0.82rem', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.3rem 0.6rem', textDecoration: 'none', color: '#374151' }}
                >
                  View scan jobs →
                </Link>
                <Link href="/import" style={{ fontSize: '0.82rem', color: '#2563eb' }}>
                  New import
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: '0.9rem', marginTop: 6 }}>
              No scan has run yet.
              <div style={{ marginTop: 8, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Link href="/activity" style={{ fontSize: '0.82rem', color: '#2563eb' }}>Open Activity</Link>
                <span style={{ color: '#e5e7eb' }}>·</span>
                <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>or run <code>netpro scan</code></span>
              </div>
            </div>
          )}
        </div>

        {/* Enrichment & Index — plan's two optional-provider strips */}
        <div style={{ ...CARD, flex: '1 1 260px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 650 }}>Enrichment & index</div>
          <div style={{ fontSize: '0.9rem', color: '#374151', marginTop: 8, display: 'grid', gap: '0.45rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.84rem', color: '#6b7280' }}>Enrichment</span>
              {stats.enrichment?.configured ? (
                <span style={{ fontSize: '0.82rem', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '0.15rem 0.55rem' }}>
                  ● {[stats.enrichment.hunter && 'Hunter', stats.enrichment.pdl && 'PDL', stats.enrichment.clearbit && 'Clearbit'].filter(Boolean).join(' · ') || 'configured'}
                </span>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#9ca3af', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 999, padding: '0.15rem 0.55rem' }}>● Not configured</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.84rem', color: '#6b7280' }}>AI / compose</span>
              {stats.ai?.configured ? (
                <span style={{ fontSize: '0.82rem', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '0.15rem 0.55rem' }}>● Configured</span>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#9ca3af', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 999, padding: '0.15rem 0.55rem' }}>● Not configured</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.84rem', color: '#6b7280' }}>Search index</span>
              <span style={{ fontSize: '0.82rem', color: '#374151', background: '#eff6ff', border: '1px solid #dbeafe', borderRadius: 999, padding: '0.15rem 0.55rem' }}>
                {stats.indexContacts !== undefined ? `${stats.indexContacts} contacts` : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.84rem', color: '#6b7280' }}>Embeddings</span>
              {stats.embeddings?.configured ? (
                <span style={{ fontSize: '0.82rem', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '0.15rem 0.55rem' }}>● Enabled</span>
              ) : (
                <span style={{ fontSize: '0.82rem', color: '#9ca3af', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 999, padding: '0.15rem 0.55rem' }}>● Disabled</span>
              )}
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <Link href="/search" style={{ color: '#2563eb', fontSize: '0.82rem' }}>
                Search →
              </Link>
              <span style={{ color: '#e5e7eb' }}>·</span>
              <Link href="/settings" style={{ color: '#2563eb', fontSize: '0.82rem' }}>
                Provider status →
              </Link>
              <span style={{ color: '#e5e7eb' }}>·</span>
              <Link href="/settings/keys" style={{ color: '#6b7280', fontSize: '0.81rem' }}>
                Keys
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom helper — what to do next */}
      <div style={{ ...CARD, marginTop: '0.85rem', background: '#f8fafc', borderStyle: 'dashed' }}>
        <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 650 }}>What to do next</div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Link
              href="/people"
              style={{ fontSize: '0.82rem', color: '#2563eb', border: '1px solid #dbeafe', background: '#eff6ff', borderRadius: 8, padding: '0.32rem 0.65rem', textDecoration: 'none' }}
            >
              Browse people
            </Link>
            <Link
              href="/network"
              style={{ fontSize: '0.82rem', color: '#374151', border: '1px solid #e5e7eb', background: 'white', borderRadius: 8, padding: '0.32rem 0.65rem', textDecoration: 'none' }}
            >
              Network →
            </Link>
            <Link
              href="/import"
              style={{ fontSize: '0.82rem', color: 'white', background: '#111827', borderRadius: 8, padding: '0.32rem 0.65rem', textDecoration: 'none' }}
            >
              Import CSV
            </Link>
          </div>
        </div>
        <ul style={{ margin: '0.55rem 0 0', paddingLeft: '1.1rem', fontSize: '0.88rem', color: '#475569', lineHeight: 1.6 }}>
          <li>
            <code>netpro import linkedin.csv</code> — import on the CLI (same job the UI sees)
          </li>
          <li>
            <code>netpro scan</code> — discover relationships, shown live above
          </li>
          <li>
            Provider keys are optional — NetPro runs fully offline; the strip above tells you what&apos;s configured.
          </li>
        </ul>
      </div>
    </div>
  );
}
