// apps/web/app/(app)/graph/page.tsx
//
// v2.0 Phase 3 — the warm-intro pathfinder surface. Server-rendered, no
// client JS, GET-form driven (the house pattern):
//   * no `target` param → network overview (communities, hubs, warm-intro
//     candidates) with per-candidate "Find a path" links;
//   * `target` (+ optional from/depth/relation/status) → the ranked
//     k-shortest chains, each hop annotated with your relationship score +
//     recency and the edge provenance, plus the one-click "Draft intro
//     request" link that pre-fills the outreach composer.
// "Which intermediary to ask" stays the owner's call: chains are RANKED
// (plan §Phase 3 deferred note), never auto-picked.
import Link from 'next/link';
import { conn } from '@/lib/db';
import {
  getNetworkGraph,
  planIntroPaths,
  introAskText,
  EDGE_RELATIONS,
  GraphError,
  PATHFINDER_LIMITS,
  type IntroPathPlan,
  type RankedIntroPath,
} from '@netpro/core/src/graph';
import { searchContacts } from '@netpro/core/src/search';
import { graphAnalysisParams } from '@/lib/graph-request';
import { scoreLabel } from '@/lib/format';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

function draftHref(plan: IntroPathPlan, path: RankedIntroPath): string {
  const text = introAskText(plan, path);
  const p = new URLSearchParams({
    contactId: path.ask.contactId,
    context: text.context,
    purpose: text.purpose,
  });
  return `/outreach?${p.toString()}`;
}

function PathChain({ plan, path }: { plan: IntroPathPlan; path: RankedIntroPath }) {
  return (
    <li key={path.rank} style={{ listStyle: 'none', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
      <p style={{ margin: 0 }}>
        <strong>#{path.rank}</strong> · {path.hops} hop{path.hops === 1 ? '' : 's'} · chain strength{' '}
        <strong>{path.score.score.toFixed(2)}</strong>
        <span style={{ color: '#6b7280' }}>
          {' '}· weakest tie {path.score.weakestTie === null ? '—' : scoreLabel(path.score.weakestTie)} ·{' '}
          hop strength {path.score.avgHopStrength.toFixed(2)}
        </span>
      </p>
      <p style={{ margin: '0.5rem 0' }}>
        {path.path.map((n, i) => (
          <span key={n.contactId}>
            {i > 0 ? (
              <span style={{ color: '#9ca3af' }}>
                {' '}
                {n.via?.relations.join(', ')}
                {n.via && n.via.minConfidence < 1 ? ` · conf ${n.via.minConfidence.toFixed(2)}` : ''}
                {n.via?.oneWay ? ' · one-way' : ''}
                {' → '}
              </span>
            ) : null}
            <Link href={`/graph/${n.contactId}`}>{n.fullName}</Link>{' '}
            <span style={{ color: '#6b7280', fontSize: '0.8rem' }} title="your tie to this contact">
              ({scoreLabel(n.relationshipScore)}
              {n.lastInteraction ? ` · ${n.lastInteraction.slice(0, 10)}` : ' · no touch'})
            </span>
          </span>
        ))}
      </p>
      <p style={{ margin: '0.25rem 0 0.5rem', fontSize: '0.9rem' }}>{path.ask.suggestion}</p>
      <p style={{ margin: 0 }}>
        <Link
          href={draftHref(plan, path)}
          style={{
            display: 'inline-block',
            padding: '0.35rem 0.75rem',
            border: '1px solid #3b82f6',
            borderRadius: 6,
            color: '#1d4ed8',
            textDecoration: 'none',
          }}
        >
          Draft intro request to {path.ask.fullName}
        </Link>
      </p>
    </li>
  );
}

export default async function GraphPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const target = one(q.target);
  const from = one(q.from);
  const depth = one(q.depth);
  const relation = one(q.relation);
  const status = one(q.status);
  const sp = new URLSearchParams();
  if (depth) sp.set('depth', depth);
  if (relation) sp.set('relation', relation);
  if (status) sp.set('status', status);
  // Hand-typed URLs must not 500 the page: bad params fall back to defaults.
  let analysis;
  try {
    analysis = graphAnalysisParams(sp);
  } catch {
    analysis = { maxDepth: 4, limit: 10 };
  }

  const [picklist, plan, planError] = await (async () => {
    const contacts = await searchContacts(conn, { sort: 'score', limit: 50 });
    if (!target) return [contacts, null as IntroPathPlan | null, null as string | null];
    try {
      const p = await planIntroPaths(
        conn,
        { target, from, k: PATHFINDER_LIMITS.defaultAlternatives },
        analysis
      );
      return [contacts, p, null] as const;
    } catch (e) {
      if (e instanceof GraphError) return [contacts, null, e.message] as const;
      throw e;
    }
  })();
  // The landing overview runs in the page (not a nested async component) so
  // the whole view resolves before render — the server components elsewhere
  // in this app render synchronously once data is in.
  const overview = target ? null : await getNetworkGraph(conn, analysis);

  const datalist = (
    <datalist id="netpro-contacts">
      {picklist.contacts.map((c) => (
        <option key={c.id} value={c.id}>
          {c.fullName}
          {c.company ? ` — ${c.company}` : ''}
        </option>
      ))}
      {picklist.total > 50 ? (
        <option value="">…top 50 by score — type any name, email, or id</option>
      ) : null}
    </datalist>
  );

  return (
    <div>
      <h1>Warm intros</h1>
      <p style={{ color: '#475569' }}>
        Pick a target and NetPro ranks the shortest chains of confirmed links to them — you choose whom
        to ask, NetPro drafts the note (nothing sends itself).{' '}
        <Link href="/edges">Manage edges</Link> · <Link href="/dashboard">Graph analytics</Link>
      </p>

      <form method="get" action="/graph" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'end', margin: '1rem 0' }}>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Target</span>
          <input name="target" defaultValue={target ?? ''} list="netpro-contacts" placeholder="name, email, or id" required style={{ padding: '0.4rem', minWidth: 200 }} />
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>From (optional)</span>
          <input name="from" defaultValue={from ?? ''} list="netpro-contacts" placeholder="your strongest tie" style={{ padding: '0.4rem', minWidth: 160 }} />
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Depth (1–{PATHFINDER_LIMITS.apiMaxDepth})</span>
          <select name="depth" defaultValue={depth ?? '4'}>
            {Array.from({ length: PATHFINDER_LIMITS.apiMaxDepth }, (_, i) => String(i + 1)).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Relation</span>
          <select name="relation" defaultValue={relation ?? ''}>
            <option value="">any</option>
            {EDGE_RELATIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Edges</span>
          <select name="status" defaultValue={status ?? 'confirmed'}>
            <option value="confirmed">confirmed</option>
            <option value="all">confirmed + pending</option>
            <option value="pending">pending only</option>
          </select>
        </label>
        <button type="submit">Find paths</button>
        {datalist}
      </form>

      {planError ? (
        <p role="alert" style={{ color: '#b91c1c' }}>{planError}</p>
      ) : plan ? (
        <section>
          <h2>
            {plan.found ? `Paths to ${plan.target.fullName}` : `No path to ${plan.target.fullName}`}
          </h2>
          <p style={{ color: '#6b7280', marginTop: '0.25rem' }}>
            From <Link href={`/graph/${plan.origin.contactId}`}>{plan.origin.fullName}</Link>
            {plan.origin.selectedBy === 'strongest-tie' ? ' (your strongest tie — set "From" to pick another)' : ''}{' '}
            · max {plan.maxDepth} hop{plan.maxDepth === 1 ? '' : 's'} ·{' '}
            {status === 'all' ? 'confirmed + pending' : status === 'pending' ? 'pending only' : 'confirmed'} edges
          </p>
          {!plan.found ? (
            <p>
              Nobody links them within {plan.maxDepth} hops over these edges —{' '}
              <Link href="/edges">add a link or review pending candidates</Link>, raise the depth, or include
              pending candidates.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {plan.paths.map((p) => (
                <PathChain key={p.rank} plan={plan} path={p} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {!target ? <Overview graph={overview!} /> : null}
    </div>
  );
}

/** The no-query landing: what the graph knows, with entry points into it. */
function Overview({ graph }: { graph: NonNullable<Awaited<ReturnType<typeof getNetworkGraph>>> }) {
  if (graph.degraded) {
    return (
      <p style={{ color: '#b45309' }}>{graph.degraded.reason}</p>
    );
  }
  if (graph.nodes === 0) {
    return (
      <p style={{ color: '#9ca3af' }}>
        No confirmed edges yet — the pathfinder needs a graph to walk.{' '}
        <Link href="/import">Import connections</Link> (mutuals arrive as pending candidates) or{' '}
        <Link href="/edges">link two people</Link>.
        {graph.pendingCandidates > 0 ? (
          <>
            {' '}
            <Link href="/edges?status=pending">{graph.pendingCandidates} pending candidate{graph.pendingCandidates === 1 ? '' : 's'} waiting for you.</Link>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2>Your graph at a glance</h2>
      <p style={{ color: '#6b7280' }}>
        {graph.nodes} of {graph.totalContacts} contacts linked by {graph.edges} edge
        {graph.edges === 1 ? '' : 's'} · {graph.components.count} component
        {graph.components.count === 1 ? '' : 's'} · modularity {graph.communities.modularity}
        {graph.pendingCandidates > 0 ? (
          <> · <Link href="/edges?status=pending">{graph.pendingCandidates} pending</Link></>
        ) : null}
      </p>
      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <h3>Hubs (most connected)</h3>
          <ul>
            {graph.centrality.top.map((t) => (
              <li key={t.contactId}>
                <Link href={`/graph/${t.contactId}`}>{t.fullName}</Link> — {t.degree} edge
                {t.degree === 1 ? '' : 's'}{' '}
                <Link href={`/graph?target=${t.contactId}`} style={{ color: '#6b7280' }}>
                  (paths to {t.fullName.split(' ')[0]}?)
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ flex: '1 1 280px' }}>
          <h3>Warm-intro candidates</h3>
          {graph.warmIntros.length === 0 ? (
            <p style={{ color: '#9ca3af' }}>Every linked contact already reaches every hub directly.</p>
          ) : (
            <ul>
              {graph.warmIntros.map((w) => (
                <li key={`${w.contactId}-${w.targetId}`}>
                  <Link href={`/graph?target=${w.targetId}&from=${w.contactId}`}>
                    {w.contactName} → {w.targetName}
                  </Link>{' '}
                  <span style={{ color: '#6b7280' }}>via {w.viaName} ({w.hops} hops)</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
