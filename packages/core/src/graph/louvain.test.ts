// Louvain on hand-built graphs with modularity computed by hand — the
// v2.0 plan's "small graphs with known answers" strategy. Every expected Q
// below is derived from the classical formula Q = Σ_c [L_c/m − (K_c/2m)²].
import { describe, expect, it } from 'vitest';
import { louvain, modularityOf, toWeightedAdjacency } from './louvain';
import { graphOf } from './testing-helpers';

describe('louvain', () => {
  it('finds the butterfly partition with modularity 1/9', () => {
    // Two triangles sharing hub 'c': a-b, b-c, c-a, c-d, d-e, e-c. m = 6.
    // Optimal: {a,b,c} (L=3, K=8) and {d,e} (L=1, K=4):
    // Q = (3/6 − (8/12)²) + (1/6 − (4/12)²) = 1/18 + 1/18 = 1/9.
    const g = graphOf(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['c', 'e'],
    ]);
    const result = louvain(g);
    expect(result.communities).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    expect(Math.abs(result.modularity - 1 / 9)).toBeLessThan(1e-9);
  });

  it('collapses a star into one community at Q = 0 (no true community structure)', () => {
    // Center c with leaves a,b,d: every partition has Q ≤ 0; the greedy
    // sweep ends at the single community (Q = L/m − (K/2m)² = 1 − 1 = 0).
    const g = graphOf(['a', 'b', 'c', 'd'], [
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'd'],
    ]);
    const result = louvain(g);
    expect(result.modularity).toBeCloseTo(0, 9);
    expect(result.communities).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('splits a 4-ring into two pairs at Q = 0 (rings have no positive-Q split)', () => {
    const g = graphOf(['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['a', 'd'],
    ]);
    const result = louvain(g);
    expect(result.communities).toEqual([['a', 'b'], ['c', 'd']]);
    expect(result.modularity).toBeCloseTo(0, 9);
  });

  it('recovers two K4 cliques bridged by one edge at Q = 11/26', () => {
    // a,b,c,d clique; e,f,g,h clique; bridge d-e. m = 13.
    // Per clique: L=6, K=13 → Q = 2 × (6/13 − (13/26)²) = 2 × (6/13 − 1/4) = 11/26.
    const g = graphOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], [
      ['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd'],
      ['e', 'f'], ['e', 'g'], ['e', 'h'], ['f', 'g'], ['f', 'h'], ['g', 'h'],
      ['d', 'e'],
    ]);
    const result = louvain(g);
    expect(result.communities).toEqual([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']]);
    expect(result.modularity).toBeCloseTo(11 / 26, 9);
  });

  it('clusters each disconnected component whole (Q = 1 − Σ (m_c/m)²)', () => {
    // Two butterflies sharing no edges: m = 12, each component m_c = 6.
    // One community per component: Q = 2 × (6/12 − (12/24)²) = 2 × 0.25 = 0.5 —
    // strictly better than splitting inside a component once m doubles, which
    // is the correct global-modularity trade-off (1 − Σ p_c² = 0.5).
    const g = graphOf(['a', 'b', 'c', 'd', 'e', 'p', 'q', 'r', 's', 't'], [
      ['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'd'], ['d', 'e'], ['c', 'e'],
      ['p', 'q'], ['q', 'r'], ['p', 'r'], ['r', 's'], ['s', 't'], ['r', 't'],
    ]);
    const result = louvain(g);
    expect(result.communities).toEqual([
      ['a', 'b', 'c', 'd', 'e'],
      ['p', 'q', 'r', 's', 't'],
    ]);
    expect(result.modularity).toBeCloseTo(0.5, 9);
  });

  it('returns an empty result for an edge-less graph and never mutates input', () => {
    const g = graphOf(['a'], []);
    expect(louvain(g)).toEqual({ membership: new Map(), modularity: 0, communities: [] });
  });

  it('is deterministic: identical graphs yield identical partitions', () => {
    const build = () =>
      graphOf(['a', 'b', 'c', 'd', 'e', 'f'], [
        ['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['d', 'f'],
      ]);
    const first = JSON.stringify(louvain(build()).communities);
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(louvain(build()).communities)).toBe(first);
    }
  });

  it('ignores self-edges and dangling endpoints', () => {
    const g = graphOf(['a', 'b'], [
      { sourceId: 'a', targetId: 'a' },
      { sourceId: 'a', targetId: 'ghost' },
      ['a', 'b'],
    ]);
    expect(g.nodes.size).toBe(2);
    expect(louvain(g).modularity).toBeCloseTo(0, 9); // K2: Q = 1 − 1 = 0
  });
});

describe('modularityOf', () => {
  it('is 0 for the trivial one-community partition', () => {
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const { adj } = toWeightedAdjacency(g);
    expect(modularityOf(adj, [0, 0, 0])).toBeCloseTo(0, 9);
  });

  it('is negative for all-singleton partitions of a connected graph', () => {
    // P3: m = 2, degrees 1,2,1 → Q = Σ_c [0/m − (k_c/2m)²] = −(1/16 + 1/4 + 1/16) = −0.375.
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const { adj } = toWeightedAdjacency(g);
    expect(modularityOf(adj, [0, 1, 2])).toBeCloseTo(-0.375, 9);
  });

  it('counts self-loops once in L and twice in K (contracted-level invariant)', () => {
    // Single node with a weight-2 self-loop: L=2, K=4, m=2 → Q = 1 − 1 = 0.
    const adj = [new Map<number, number>([[0, 2]])];
    expect(modularityOf(adj, [0])).toBeCloseTo(0, 9);
  });
});

describe('toWeightedAdjacency', () => {
  it('sums parallel relations and never double-counts a symmetric pair', () => {
    const g = graphOf(['a', 'b'], [
      { sourceId: 'a', targetId: 'b', relation: 'colleague' },
      { sourceId: 'a', targetId: 'b', relation: 'met_at_event', id: 'edge-2' },
    ]);
    const { adj, m } = toWeightedAdjacency(g);
    expect(adj[0]!.get(1)).toBe(2);
    expect(adj[1]!.get(0)).toBe(2);
    expect(m).toBe(2);
  });

  it('treats one-way rows as connected for clustering (undirected posture)', () => {
    const g = graphOf(['a', 'b'], [{ sourceId: 'a', targetId: 'b', bidirectional: false }]);
    const { adj, m } = toWeightedAdjacency(g);
    expect(adj[0]!.get(1)).toBe(1);
    expect(adj[1]!.get(0)).toBe(1);
    expect(m).toBe(1);
  });
});
