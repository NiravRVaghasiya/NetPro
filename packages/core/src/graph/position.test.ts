// v2.0 Phase 3 — per-contact graph position (`/graph/<id>` view model).
import { afterAll, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addEdge } from './edges';
import { getContactGraphPosition } from './position';
import { GraphError } from './types';

const NOW = new Date('2026-09-07T12:00:00Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

const db = createTestSqliteConn();
afterAll(() => db.sqlite.close());

interface SeedContact {
  id: string;
  fullName: string;
  company?: string | null;
  score?: number | null;
  last?: string | null;
  deleted?: boolean;
}

async function seed(
  contacts: SeedContact[],
  edges: Array<Parameters<typeof addEdge>[1]> = []
) {
  db.sqlite.exec('DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;');
  for (const c of contacts) {
    await db.conn.db.insert(db.conn.schema.contacts).values({
      id: c.id,
      fullName: c.fullName,
      company: c.company ?? null,
      relationshipScore: c.score ?? null,
      lastInteraction: c.last ?? null,
      source: 'test',
      createdAt: iso(300),
      updatedAt: NOW.toISOString(),
      deletedAt: c.deleted ? iso(1) : null,
    });
  }
  for (const e of edges) await addEdge(db.conn, e, { now: NOW });
}

describe('getContactGraphPosition', () => {
  it('reports centrality, community and reachability for an in-graph contact', async () => {
    // a — b — z, a — b2: b(bridge) degree 2; community label = dominant company.
    await seed(
      [
        { id: 'a', fullName: 'Ada', company: 'Acme', score: 0.7 },
        { id: 'b', fullName: 'Bob', company: 'Acme', score: 0.5 },
        { id: 'z', fullName: 'Zoe', company: 'Acme', score: 0.2 },
      ],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' },
        { sourceId: 'b', targetId: 'z', relation: 'met_at_event' },
      ]
    );
    const pos = await getContactGraphPosition(db.conn, 'b');
    expect(pos.inGraph).toBe(true);
    expect(pos.analyzed).toEqual({ nodes: 3, edges: 2 });
    expect(pos.centrality.degree).toBe(2);
    expect(pos.centrality.degreeRank).toBe(1); // only hub here
    expect(pos.centrality.betweenness).toBe(1); // P3 middle, normalized 1.0
    expect(pos.community?.label).toBe('acme');
    expect(pos.community?.size).toBe(3);
    expect(pos.reachableWithinDepth).toBe(2);
    expect(pos.neighbors.map((n) => n.contactId).sort()).toEqual(['a', 'z']);
    expect(pos.degraded).toBeNull();
  });

  it('shows PENDING edges in adjacency while excluding them from analysis', async () => {
    await seed(
      [
        { id: 'a', fullName: 'Ada', score: 0.9 },
        { id: 'b', fullName: 'Bob', score: 0.5 },
      ],
      [
        // inferred candidate (linkedin source) — lands pending:
        { sourceId: 'a', targetId: 'b', relation: 'mutual_network', source: 'linkedin_csv' },
      ]
    );
    const pos = await getContactGraphPosition(db.conn, 'a');
    expect(pos.inGraph).toBe(false); // confirmed-only analysis sees nothing
    expect(pos.neighbors).toHaveLength(1);
    expect(pos.neighbors[0]).toMatchObject({ contactId: 'b', status: 'pending', direction: 'both' });
    expect(pos.centrality.degree).toBe(0);
    expect(pos.centrality.betweennessNote).toContain('no confirmed edges');
  });

  it('tracks one-way rows in the adjacency direction', async () => {
    await seed(
      [
        { id: 'a', fullName: 'Ada' },
        { id: 'b', fullName: 'Bob' },
      ],
      [{ sourceId: 'a', targetId: 'b', bidirectional: false }]
    );
    const fromSource = await getContactGraphPosition(db.conn, 'a');
    const fromTarget = await getContactGraphPosition(db.conn, 'b');
    expect(fromSource.neighbors[0]!.direction).toBe('out');
    expect(fromTarget.neighbors[0]!.direction).toBe('in');
  });

  it('lists warm-intro suggestions this contact appears in', async () => {
    // chain: low → hub via b — b should surface in `warmIntros` for itself.
    await seed(
      [
        { id: 'a', fullName: 'Ada', score: 0.9 },
        { id: 'b', fullName: 'Bob', score: 0.8 },
        { id: 'c', fullName: 'Cara', score: 0.1 },
      ],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' },
        { sourceId: 'b', targetId: 'c', relation: 'colleague' },
      ]
    );
    const pos = await getContactGraphPosition(db.conn, 'b');
    expect(pos.warmIntros.length).toBeGreaterThan(0);
    for (const w of pos.warmIntros) {
      expect([w.contactId, w.targetId, w.viaId]).toContain('b');
    }
  });

  it('degrades honestly when the graph is over the edge budget', async () => {
    await seed(
      [
        { id: 'a', fullName: 'Ada' },
        { id: 'b', fullName: 'Bob' },
      ],
      [{ sourceId: 'a', targetId: 'b' }]
    );
    const pos = await getContactGraphPosition(db.conn, 'a', { limits: { maxEdges: 0 } as never });
    // maxEdges 0 → every graph exceeds it → degraded sections, adjacency intact:
    expect(pos.degraded).toContain('capped');
    expect(pos.neighbors).toHaveLength(1);
    expect(pos.centrality.degree).toBeNull();
  });

  it('404s for unknown and soft-deleted contacts', async () => {
    await seed([{ id: 'a', fullName: 'Ada' }, { id: 'g', fullName: 'Ghost', deleted: true }]);
    await expect(getContactGraphPosition(db.conn, 'nope')).rejects.toBeInstanceOf(GraphError);
    await expect(getContactGraphPosition(db.conn, 'g')).rejects.toMatchObject({ code: 'not_found' });
  });
});
