// Performance budget from the v2.0 plan §Phase 2: "3,000 nodes / 8,000 edges
// under the analytics budget (< 500 ms dashboard load; measure and record)".
// The test asserts a CI-safe multiple of the budget and records the actual
// measurement; the progress doc carries the number this machine reported.
import { describe, expect, it } from 'vitest';
import { buildGraph } from './analysis';
import { louvain } from './louvain';
import { brandesBetweenness, degreeCentrality } from './centrality';
import { avgPathLengthOf, componentsOf, warmIntrosOf } from './network';
import { shortestPaths } from './paths';
import type { EdgeReadRow, GraphContactRow } from './analysis';

/** Deterministic LCG — stable synthetic graphs across runs and machines. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function syntheticGraph(nodeCount: number, edgeCount: number) {
  const rand = rng(42);
  const contacts: GraphContactRow[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `c${String(i).padStart(5, '0')}`,
    fullName: `Contact ${i}`,
    company: i % 7 === 0 ? 'Stripe' : null,
    industry: null,
    role: null,
    relationshipScore: Math.round(rand() * 100) / 100,
    lastInteraction: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const seen = new Set<string>();
  const edges: EdgeReadRow[] = [];
  // Clustered structure: most edges stay within a block of 10 ids so Louvain
  // has real communities to find (a pure random graph would be a single blob).
  while (edges.length < edgeCount) {
    const i = Math.floor(rand() * nodeCount);
    const j = (i + 1 + Math.floor(rand() * (rand() < 0.85 ? 10 : nodeCount - 1))) % nodeCount;
    if (i === j) continue;
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `e${edges.length}`,
      sourceId: contacts[Math.min(i, j)]!.id,
      targetId: contacts[Math.max(i, j)]!.id,
      relation: 'manual',
      strength: 0.5,
      confidence: 1,
      bidirectional: true,
    });
  }
  return buildGraph(edges, contacts);
}

describe('graph analytics performance budget', () => {
  it('3,000 nodes / 8,000 edges: the dashboard pipeline stays inside budget', () => {
    const graph = syntheticGraph(3_000, 8_000);
    expect(graph.stats.edges).toBe(8_000);
    const t0 = performance.now();
    const communities = louvain(graph);
    const degree = degreeCentrality(graph);
    const betweenness = brandesBetweenness(graph); // over budget at 3k → skipped by design
    const components = componentsOf(graph);
    const apl = avgPathLengthOf(graph, 600);
    const intros = warmIntrosOf(graph, 4, 10);
    const ms = performance.now() - t0;
    // Recorded for the progress doc — "measure and record" is the plan's ask.
    console.info(
      `[perf] 3000n/8000e full pipeline: ${ms.toFixed(1)} ms ` +
        `(${communities.communities.length} communities, ${degree.length} degrees, betweenness ${
          betweenness.entries ? 'computed' : 'skipped'
        }, ${components.count} components, APL ${apl.value}, ${intros.length} intros)`
    );
    expect(ms).toBeLessThan(1_500);
    expect(betweenness.entries).toBeNull(); // budget honesty: no accidental O(V·E) on the request path
    expect(apl.basis).toBe('skipped');
  }, 30_000);

  it('betweenness inside its own budget (1,500 nodes) completes quickly', () => {
    const graph = syntheticGraph(1_400, 2_800);
    const t0 = performance.now();
    const { entries, skippedReason } = brandesBetweenness(graph);
    const ms = performance.now() - t0;
    console.info(`[perf] Brandes on 1400n/2800e: ${ms.toFixed(1)} ms`);
    expect(skippedReason).toBeNull();
    // Synthetic coverage leaves a few contacts edge-less — nodes are exactly
    // the contacts touched by at least one edge.
    expect(entries).toHaveLength(graph.nodes.size);
    expect(graph.nodes.size).toBeGreaterThan(1_200);
    expect(ms).toBeLessThan(3_000);
  }, 30_000);

  it('pathfinder on the large graph is depth-bounded, not graph-sized', () => {
    const graph = syntheticGraph(3_000, 8_000);
    const t0 = performance.now();
    let found = 0;
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const from = `c${String(Math.floor(rand() * 3000)).padStart(5, '0')}`;
      const to = `c${String(Math.floor(rand() * 3000)).padStart(5, '0')}`;
      if (shortestPaths(graph, from, to, 4).length > 0) found++;
    }
    const ms = performance.now() - t0;
    console.info(`[perf] 200 depth-4 BFS path queries on 3000n/8000e: ${ms.toFixed(1)} ms (${found} found)`);
    expect(ms).toBeLessThan(3_000);
  }, 30_000);
});
