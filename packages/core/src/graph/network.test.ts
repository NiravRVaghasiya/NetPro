// getNetworkGraph against the migrated fixture: two triangles bridged by
// b–d with hand-computed expectations (m = 7 → Q = 5/14; Σ distances 27 /
// 15 pairs = 1.8 avg path length).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addEdge } from './edges';
import { getCommunities } from './communities';
import { getCentrality } from './centrality';
import { getNetworkGraph, avgPathLengthOf, componentsOf, warmIntrosOf } from './network';
import { graphOf } from './testing-helpers';

const fixture = createTestSqliteConn();
const NOW = new Date('2026-09-07T12:00:00Z');

async function seedTriangles() {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  const people: Array<[string, string, number | null]> = [
    ['a', 'Ada Lovelace', 0.2],
    ['b', 'Bob Builder', 0.9],
    ['c', 'Cara Chen', 0.3],
    ['d', 'Dan Delta', 0.7],
    ['e', 'Eve East', 0.1],
    ['f', 'Fay Fair', null],
  ];
  for (const [id, fullName, score] of people) {
    await fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id,
        fullName,
        source: 'test',
        relationshipScore: score,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
  }
  for (const [s, t] of [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
    ['d', 'e'],
    ['e', 'f'],
    ['f', 'd'],
    ['b', 'd'],
  ] as const) {
    await addEdge(fixture.conn, { sourceId: s, targetId: t }, { now: NOW });
  }
}

beforeEach(seedTriangles);
afterAll(() => fixture.sqlite.close());

describe('getNetworkGraph', () => {
  it('computes the full merged view on a bridged-triangles fixture', async () => {
    const g = await getNetworkGraph(fixture.conn, { now: NOW });
    expect(g.totalContacts).toBe(6);
    expect(g.nodes).toBe(6);
    expect(g.edges).toBe(7);
    expect(g.coverage).toBe(1);
    expect(g.pendingCandidates).toBe(0);
    expect(g.dangling).toBe(0);
    expect(g.degraded).toBeNull();
    expect(g.generatedAt).toBe(NOW.toISOString());

    expect(g.communities.count).toBe(2);
    expect(g.communities.modularity).toBeCloseTo(5 / 14, 4);
    expect(g.communities.top.map((c) => c.members.map((m) => m.contactId))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);

    expect(g.components).toEqual({ count: 1, largestSize: 6, outsideLargest: 0 });
    expect(g.avgPathLength).toEqual({ value: 1.8, basis: 'exact', note: null });

    expect(g.centrality.top.length).toBeGreaterThan(0);
    expect(g.centrality.top[0]!.contactId).toBe('b'); // degree 3, first by id among ties
    expect(g.centrality.top[0]!.degree).toBe(3);
    expect(g.centrality.betweennessComputed).toBe(true);
    // The b–d bridge is a cut edge: b is interior to {a,c}×{d,e,f} (6 pairs)
    // and d likewise → raw 6 each; norm = 6 / ((6−1)(6−2)/2 = 10) = 0.6.
    expect(g.centrality.top[0]!.betweenness).toBeCloseTo(0.6, 3);
    expect(g.centrality.top[1]!.contactId).toBe('d');
    expect(g.centrality.top[1]!.betweenness).toBeCloseTo(0.6, 3);
  });

  it('lists warm-intro candidates: (a,c)→d via b before (e,f)→b via d', async () => {
    const g = await getNetworkGraph(fixture.conn, { now: NOW });
    expect(g.warmIntros.slice(0, 4).map((w) => [w.contactId, w.targetId, w.viaId, w.hops])).toEqual([
      ['a', 'd', 'b', 2],
      ['c', 'd', 'b', 2],
      ['e', 'b', 'd', 2],
      ['f', 'b', 'd', 2],
    ]);
    for (const w of g.warmIntros) {
      expect(w.chain).toHaveLength(w.hops + 1);
      expect(w.chain[0]!.contactId).toBe(w.contactId);
      expect(w.chain[w.chain.length - 1]!.contactId).toBe(w.targetId);
    }
  });

  it('empty-state: contacts without edges', async () => {
    fixture.sqlite.exec('DELETE FROM edges; DELETE FROM activity_log;');
    const g = await getNetworkGraph(fixture.conn, { now: NOW });
    expect(g.nodes).toBe(0);
    expect(g.edges).toBe(0);
    expect(g.coverage).toBe(0);
    expect(g.degraded).toBeNull();
    expect(g.communities).toMatchObject({ count: 0, modularity: 0 });
    expect(g.centrality.top).toEqual([]);
    expect(g.components).toEqual({ count: 0, largestSize: 0, outsideLargest: 0 });
    expect(g.avgPathLength.value).toBeNull();
    expect(g.warmIntros).toEqual([]);
  });

  it('counts pending candidates without letting them into the analysis', async () => {
    await addEdge(
      fixture.conn,
      { sourceId: 'e', targetId: 'a', relation: 'mutual_network', source: 'linkedin_csv' },
      { now: NOW }
    );
    const g = await getNetworkGraph(fixture.conn, { now: NOW });
    expect(g.pendingCandidates).toBe(1);
    expect(g.edges).toBe(7); // still confirmed-only
    const withPending = await getNetworkGraph(fixture.conn, { status: 'all', now: NOW });
    expect(withPending.edges).toBe(8);
  });

  it('drops edges to soft-deleted contacts and reports them as dangling', async () => {
    fixture.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), 'f');
    await fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ id: 'iso', fullName: 'Isolated Ivan', source: 'test', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    const g = await getNetworkGraph(fixture.conn, { now: NOW });
    expect(g.dangling).toBe(2); // f–d and e–f
    expect(g.totalContacts).toBe(6);
    expect(g.nodes).toBe(5);
    expect(g.coverage).toBeCloseTo(5 / 6, 3);
  });

  it('degrades past the edge cap with a notice instead of hanging', async () => {
    const g = await getNetworkGraph(fixture.conn, { now: NOW, limits: { maxEdges: 6 } });
    expect(g.degraded).toMatchObject({ edges: 7, maxEdges: 6 });
    expect(g.degraded!.reason).toMatch(/capped/);
    expect(g.communities.count).toBe(0);
    expect(g.warmIntros).toEqual([]);
    expect(g.nodes).toBe(6); // stats are still reported
  });

  it('skips betweenness past its node budget but keeps degree', async () => {
    const g = await getNetworkGraph(fixture.conn, { now: NOW, limits: { betweennessMaxNodes: 5 } });
    expect(g.centrality.betweennessComputed).toBe(false);
    expect(g.centrality.top[0]!.betweenness).toBeNull();
    expect(g.centrality.top[0]!.degree).toBe(3);
    expect(g.centrality.skippedReason).toMatch(/betweenness skipped/);
  });

  it('skips exact average path length past its budget', async () => {
    const g = await getNetworkGraph(fixture.conn, { now: NOW, limits: { avgPathLengthMaxNodes: 4 } });
    expect(g.avgPathLength).toMatchObject({ value: null, basis: 'skipped' });
    expect(g.avgPathLength.note).toMatch(/budget/);
  });

  it('is deterministic: identical inputs produce identical payloads', async () => {
    const a = JSON.stringify(await getNetworkGraph(fixture.conn, { now: NOW }));
    const b = JSON.stringify(await getNetworkGraph(fixture.conn, { now: NOW }));
    expect(a).toBe(b);
  });
});

describe('getCommunities / getCentrality entry points', () => {
  it('labels communities by dominant company, falling back to Community N', async () => {
    fixture.sqlite.exec(
      "UPDATE contacts SET company = 'Stripe' WHERE id IN ('a','b','c'); " +
        "UPDATE contacts SET company = 'Vercel' WHERE id IN ('a','b');"
    );
    const c = await getCommunities(fixture.conn, { now: NOW });
    expect(c.count).toBe(2);
    // {a,b,c}: Vercel×2 + Stripe×1 → dominant 'vercel'; {d,e,f} has no companies.
    expect(c.top[0]!.label).toBe('vercel');
    expect(c.top[1]!.label).toBe('Community 2');
  });

  it('caps lists via limit', async () => {
    const c = await getCommunities(fixture.conn, { limit: 1, now: NOW });
    expect(c.top).toHaveLength(1);
    const cen = await getCentrality(fixture.conn, { limit: 2, now: NOW });
    expect(cen.top).toHaveLength(2);
  });
});

describe('pure sections over synthetic graphs', () => {
  it('componentsOf: disconnected triangles', () => {
    const g = graphOf(
      ['a', 'b', 'c', 'x', 'y', 'z'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'y'], ['y', 'z'], ['z', 'x']]
    );
    // Two equal components: "largest" is size 3, so 3 nodes sit outside it.
    expect(componentsOf(g)).toEqual({ count: 2, largestSize: 3, outsideLargest: 3 });
  });

  it('avgPathLengthOf: triangle = 1.00, star of 4 = 1.50', () => {
    const tri = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    expect(avgPathLengthOf(tri, 600)).toEqual({ value: 1, basis: 'exact', note: null });
    const star = graphOf(['c', 'a', 'b', 'd'], [['a', 'c'], ['b', 'c'], ['c', 'd']]);
    // Pairs: leaf-center 3×1, leaf-leaf 3×2 → (3+6)/6 = 1.5.
    expect(avgPathLengthOf(star, 600).value).toBe(1.5);
  });

  it('warmIntrosOf: never proposes a pair that is already adjacent', () => {
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const out = warmIntrosOf(g, 4, 10);
    expect(out).toHaveLength(2); // (a,c) and (c,a) — both 2 hops via b
    for (const w of out) {
      expect(w.viaId).toBe('b');
      expect(w.hops).toBe(2);
      expect([w.contactId, w.targetId].includes('b')).toBe(false);
    }
  });
});
