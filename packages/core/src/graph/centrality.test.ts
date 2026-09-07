// Centrality on the vintage small graphs where betweenness is countable by
// hand (v2.0 plan §Phase 2: "betweenness on the vintage 4-node examples").
import { describe, expect, it } from 'vitest';
import { brandesBetweenness, degreeCentrality } from './centrality';
import { graphOf } from './testing-helpers';

const byId = <T extends { contactId: string }>(entries: T[]) =>
  new Map(entries.map((e) => [e.contactId, e]));

describe('degreeCentrality', () => {
  it('counts unique neighbors symmetrically, even for one-way rows', () => {
    const g = graphOf(['a', 'b', 'c'], [
      { sourceId: 'a', targetId: 'b', bidirectional: false },
      ['b', 'c'],
    ]);
    const rows = byId(degreeCentrality(g));
    expect(rows.get('a')!.degree).toBe(1); // a's neighbors list is undirected too
    expect(rows.get('b')!.degree).toBe(2);
    expect(rows.get('c')!.degree).toBe(1);
    expect(rows.get('b')!.normalized).toBeCloseTo(1, 9); // 2 / (3 − 1)
    expect(rows.get('a')!.normalized).toBeCloseTo(0.5, 9);
  });

  it('sorts by degree desc then id asc (deterministic)', () => {
    const g = graphOf(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b'], ['a', 'c'], ['a', 'd'], ['e', 'b'], // a:3, b:2
    ]);
    expect(degreeCentrality(g).map((r) => r.contactId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('handles n = 1 incident pair without division by zero', () => {
    const g = graphOf(['a', 'b'], [['a', 'b']]);
    for (const r of degreeCentrality(g)) expect(r.normalized).toBeCloseTo(1, 9); // 1/(2−1)
  });
});

describe('brandesBetweenness', () => {
  it('scores the middle pair of a 4-path at 2/3 each', () => {
    // P4 a–b–c–d: pairs (a,c), (a,d) route through b; (a,d), (b,d) through c.
    // Raw 2 each; norm = (n−1)(n−2)/2 = 3 → 2/3.
    const g = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    const { entries } = brandesBetweenness(g);
    const rows = byId(entries!);
    expect(rows.get('a')!.raw).toBe(0);
    expect(rows.get('b')!.raw).toBeCloseTo(2, 9);
    expect(rows.get('c')!.raw).toBeCloseTo(2, 9);
    expect(rows.get('d')!.raw).toBe(0);
    expect(rows.get('b')!.normalized).toBeCloseTo(2 / 3, 9);
  });

  it('gives a 4-star center normalized betweenness 1.0', () => {
    // All three leaf–leaf pairs (3 of them) route through the center; norm = 3.
    const g = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['a', 'd']]);
    const rows = byId(brandesBetweenness(g).entries!);
    expect(rows.get('a')!.raw).toBeCloseTo(3, 9);
    expect(rows.get('a')!.normalized).toBeCloseTo(1, 9);
    expect(rows.get('b')!.normalized).toBe(0);
  });

  it('gives the butterfly hub 4 raw / 2/3 normalized', () => {
    const g = graphOf(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'd'], ['d', 'e'], ['c', 'e'],
    ]);
    const rows = byId(brandesBetweenness(g).entries!);
    expect(rows.get('c')!.raw).toBeCloseTo(4, 9);
    expect(rows.get('c')!.normalized).toBeCloseTo(4 / 6, 9);
  });

  it('is zero inside a triangle (every pair is adjacent)', () => {
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['a', 'c']]);
    for (const e of brandesBetweenness(g).entries!) expect(e.raw).toBe(0);
  });

  it('reports 0 (not NaN) for tiny graphs', () => {
    const g = graphOf(['a', 'b'], [['a', 'b']]);
    for (const e of brandesBetweenness(g).entries!) {
      expect(e.raw).toBe(0);
      expect(e.normalized).toBe(0);
    }
  });

  it('skips past the node budget and says why', () => {
    const g = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    const { entries, skippedReason } = brandesBetweenness(g, { limits: { betweennessMaxNodes: 3 } });
    expect(entries).toBeNull();
    expect(skippedReason).toMatch(/exceeds the 3-node budget/);
  });

  it('treats a one-way row as connected (undirected posture)', () => {
    const g = graphOf(['a', 'b', 'c', 'd'], [
      { sourceId: 'a', targetId: 'b', bidirectional: false },
      ['b', 'c'],
      ['c', 'd'],
    ]);
    const rows = byId(brandesBetweenness(g).entries!);
    expect(rows.get('b')!.raw).toBeCloseTo(2, 9); // same as undirected P4
  });
});
