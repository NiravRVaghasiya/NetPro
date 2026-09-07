// apps/web/app/(app)/graph/[contactId]/page.tsx
//
// v2.0 Phase 3 — one contact's position in the graph (plan: "/graph/<id>
// shows centrality + communities for that person"), plus their adjacency
// (pending candidates included, so this page doubles as a confirmation
// entry point) and the warm-intro suggestions they appear in. Unknown or
// soft-deleted ids 404 — the boundary the plan's verification demands.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conn } from '@/lib/db';
import { getContactGraphPosition, GraphError, type GraphNeighborRow } from '@netpro/core/src/graph';
import { scoreLabel, utcDay } from '@/lib/format';

const DIRECTION: Record<GraphNeighborRow['direction'], string> = {
  both: '↔',
  out: '→',
  in: '←',
};

export default async function GraphContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  let pos;
  try {
    pos = await getContactGraphPosition(conn, contactId);
  } catch (e) {
    if (e instanceof GraphError && e.code === 'not_found') notFound();
    throw e;
  }

  return (
    <div>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/graph">← Warm intros</Link>
      </p>
      <h1>{pos.contact.fullName} in your graph</h1>
      <p style={{ color: '#475569', margin: '0.25rem 0' }}>
        {[pos.contact.role, pos.contact.company].filter(Boolean).join(' · ') || '—'} ·{' '}
        <Link href={`/contacts/${pos.contact.id}`}>open contact</Link>
      </p>

      {pos.degraded ? <p style={{ color: '#b45309' }}>{pos.degraded}</p> : null}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', margin: '1rem 0' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 1rem', minWidth: 140 }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Degree</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>
            {pos.centrality.degree ?? 0}
            {pos.centrality.degreeRank ? (
              <span style={{ fontSize: '0.8rem', color: '#9ca3af', fontWeight: 400 }}> · rank #{pos.centrality.degreeRank} of {pos.analyzed.nodes}</span>
            ) : null}
          </div>
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 1rem', minWidth: 140 }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Betweenness</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>
            {pos.centrality.betweenness ?? '–'}
          </div>
          {pos.centrality.betweennessNote ? (
            <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{pos.centrality.betweennessNote}</div>
          ) : null}
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 1rem', minWidth: 140 }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Community</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{pos.community?.label ?? '—'}</div>
          {pos.community ? (
            <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{pos.community.size} members</div>
          ) : null}
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 1rem', minWidth: 140 }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Reachable</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{pos.reachableWithinDepth}</div>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>contacts within 4 hops</div>
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 1rem', minWidth: 140 }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Your tie</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{scoreLabel(pos.contact.relationshipScore)}</div>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
            {pos.contact.lastInteraction ? `last touch ${utcDay(pos.contact.lastInteraction)}` : 'no recorded touch'}
          </div>
        </div>
      </div>

      <h2>Links ({pos.neighbors.length})</h2>
      {pos.neighbors.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>
          No edges from or to this contact — <Link href={`/edges`}>add one</Link> and the pathfinder can use it.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Relation</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Strength</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>
            {pos.neighbors.map((n) => (
              <tr key={n.edgeId}>
                <td>
                  {DIRECTION[n.direction]} <Link href={`/contacts/${n.contactId}`}>{n.fullName}</Link>
                </td>
                <td>{n.relation}</td>
                <td style={{ color: n.status === 'pending' ? '#b45309' : undefined }}>{n.status}</td>
                <td>{n.confidence.toFixed(2)}</td>
                <td>{n.strength.toFixed(2)}</td>
                <td>{n.context ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pos.warmIntros.length > 0 ? (
        <section style={{ marginTop: '1.5rem' }}>
          <h2>Warm-intro suggestions involving {pos.contact.fullName.split(' ')[0]}</h2>
          <ul>
            {pos.warmIntros.map((w) => (
              <li key={`${w.contactId}-${w.targetId}`}>
                <Link href={`/graph?target=${w.targetId}&from=${w.contactId}`}>
                  {w.contactName} → {w.targetName}
                </Link>{' '}
                <span style={{ color: '#6b7280' }}>via {w.viaName} ({w.hops} hops)</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
