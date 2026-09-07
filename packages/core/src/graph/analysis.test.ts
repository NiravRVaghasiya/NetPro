import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addEdge } from './edges';
import { buildGraph, loadGraph, resolveGraphAnalysisOptions, GRAPH_ANALYSIS_LIMITS } from './analysis';
import { GraphError } from './types';
import { testContact, testEdge } from './testing-helpers';

describe('resolveGraphAnalysisOptions', () => {
  it('applies the plan defaults', () => {
    const r = resolveGraphAnalysisOptions();
    expect(r.statuses).toEqual(['confirmed']);
    expect(r.relation).toBeNull();
    expect(r.minConfidence).toBe(0);
    expect(r.limit).toBe(10);
    expect(r.maxDepth).toBe(4); // the blueprint's reference depth
    expect(r.limits).toEqual({
      maxEdges: GRAPH_ANALYSIS_LIMITS.maxEdges,
      betweennessMaxNodes: GRAPH_ANALYSIS_LIMITS.betweennessMaxNodes,
      avgPathLengthMaxNodes: GRAPH_ANALYSIS_LIMITS.avgPathLengthMaxNodes,
      communityMembers: GRAPH_ANALYSIS_LIMITS.communityMembers,
    });
  });

  it('maps status filters; rejected is never a choice', () => {
    expect(resolveGraphAnalysisOptions({ status: 'pending' }).statuses).toEqual(['pending']);
    expect(resolveGraphAnalysisOptions({ status: 'all' }).statuses).toEqual(['confirmed', 'pending']);
    expect(() => resolveGraphAnalysisOptions({ status: 'rejected' as never })).toThrow(GraphError);
  });

  it('whitelists relation and validates confidence', () => {
    expect(resolveGraphAnalysisOptions({ relation: 'colleague' }).relation).toBe('colleague');
    expect(() => resolveGraphAnalysisOptions({ relation: 'besties' })).toThrow(/Unknown relation/);
    expect(() => resolveGraphAnalysisOptions({ minConfidence: 1.5 })).toThrow(/between 0 and 1/);
    expect(() => resolveGraphAnalysisOptions({ minConfidence: NaN })).toThrow(/between 0 and 1/);
  });

  it('clamps depth and limit into range', () => {
    expect(resolveGraphAnalysisOptions({ maxDepth: 0 }).maxDepth).toBe(1);
    expect(resolveGraphAnalysisOptions({ maxDepth: 99 }).maxDepth).toBe(GRAPH_ANALYSIS_LIMITS.maxDepthCap);
    expect(resolveGraphAnalysisOptions({ limit: 0 }).limit).toBe(1);
    expect(resolveGraphAnalysisOptions({ limit: 999 }).limit).toBe(GRAPH_ANALYSIS_LIMITS.listLimitCap);
  });

  it('test-seam caps can only shrink', () => {
    expect(resolveGraphAnalysisOptions({ limits: { maxEdges: 10 } }).limits.maxEdges).toBe(10);
    expect(resolveGraphAnalysisOptions({ limits: { maxEdges: 999_999 } }).limits.maxEdges).toBe(
      GRAPH_ANALYSIS_LIMITS.maxEdges
    );
  });
});

describe('buildGraph (pure join)', () => {
  const contacts = [testContact('a'), testContact('b'), testContact('c'), testContact('lonely')];

  it('creates symmetric undirected adjacency plus directed out-edges', () => {
    const g = buildGraph(
      [testEdge('a', 'b'), testEdge('b', 'c', { bidirectional: false })],
      contacts
    );
    expect(g.nodes.size).toBe(3);
    expect(g.neighbors.get('a')).toEqual(['b']);
    expect(g.neighbors.get('b')).toEqual(['a', 'c']); // one-way still connects both ways
    expect(g.neighbors.get('c')).toEqual(['b']);
    const bToC = g.out.get('b')!.map((e) => e.targetId);
    expect(bToC).toContain('c');
    expect(g.out.get('c') ?? []).toHaveLength(0); // …but not traversable in reverse
    expect(g.stats).toMatchObject({ totalContacts: 4, nodes: 3, edges: 2, uncoveredContacts: 1, dangling: 0 });
  });

  it('drops self-edges silently and dangling endpoints as counted drops', () => {
    const g = buildGraph(
      [testEdge('a', 'a'), testEdge('a', 'ghost'), testEdge('a', 'b')],
      contacts
    );
    expect(g.stats.dangling).toBe(1);
    expect(g.edges.map((e) => e.id)).toEqual([g.edges[0]!.id]);
    expect(g.edges[0]!.targetId).toBe('b');
  });

  it('defaults null strength/confidence to the schema values', () => {
    const g = buildGraph([{ id: 'x', sourceId: 'a', targetId: 'b', relation: 'manual', strength: null, confidence: null, bidirectional: null } as never], contacts);
    expect(g.edges[0]).toMatchObject({ strength: 0.5, confidence: 1, bidirectional: true });
  });

  it('orders nodes and edges by id for determinism', () => {
    const g = buildGraph([testEdge('c', 'b', { id: 'z' }), testEdge('b', 'a', { id: 'y' })], contacts);
    expect(Array.from(g.nodes.keys())).toEqual(['a', 'b', 'c']);
    expect(g.edges.map((e) => e.id)).toEqual(['y', 'z']);
  });
});

describe('loadGraph (DB status/confidence filters)', () => {
  const fixture = createTestSqliteConn();
  const NOW = new Date('2026-09-07T12:00:00Z');

  beforeEach(async () => {
    fixture.sqlite.exec('DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;');
    for (const id of ['a', 'b', 'c']) {
      await fixture.conn.db
        .insert(fixture.conn.schema.contacts)
        .values({ id, fullName: id, source: 'test', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    }
    await addEdge(fixture.conn, { sourceId: 'a', targetId: 'b', relation: 'colleague' }, { now: NOW });
    await addEdge(fixture.conn, { sourceId: 'b', targetId: 'c', source: 'linkedin_csv' }, { now: NOW }); // pending
    await addEdge(
      fixture.conn,
      { sourceId: 'a', targetId: 'c', source: 'linkedin_csv', confidence: 0.3 },
      { now: NOW }
    );
    await setRejected();
  });
  afterAll(() => fixture.sqlite.close());

  async function setRejected() {
    const pending = fixture.sqlite
      .prepare("SELECT id FROM edges WHERE source_id = 'a' AND target_id = 'c'")
      .get() as { id: string } | undefined;
    if (pending) {
      fixture.sqlite.prepare('UPDATE edges SET status = ? WHERE id = ?').run('rejected', pending.id);
    }
  }

  it('loads only confirmed edges by default', async () => {
    const g = await loadGraph(fixture.conn);
    expect(g.stats.edges).toBe(1);
    expect(g.edges[0]).toMatchObject({ sourceId: 'a', targetId: 'b', relation: 'colleague' });
  });

  it('includes pending with status=all but never rejected rows', async () => {
    const g = await loadGraph(fixture.conn, { status: 'all' });
    expect(g.stats.edges).toBe(2); // pending a–c is rejected → excluded
    expect(g.edges.map((e) => `${e.sourceId}-${e.targetId}`).sort()).toEqual(['a-b', 'b-c']);
  });

  it('filters by relation and confidence in SQL, not JS', async () => {
    const g = await loadGraph(fixture.conn, { status: 'all', minConfidence: 0.5 });
    expect(g.edges.every((e) => e.confidence >= 0.5)).toBe(true);
    const rel = await loadGraph(fixture.conn, { status: 'all', relation: 'colleague' });
    expect(rel.edges).toHaveLength(1);
  });
});
