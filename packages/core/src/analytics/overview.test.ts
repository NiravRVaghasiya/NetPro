// getNetworkOverview ↔ graph-analytics integration (v2.0 Phase 2): the
// shared payload the CLI and dashboard render from.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addEdge } from '../graph/edges';
import { getNetworkOverview } from './overview';

const fixture = createTestSqliteConn();
const NOW = new Date('2026-09-07T12:00:00Z');

beforeAll(async () => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  const people: Array<[string, string, string, number | null]> = [
    ['a', 'Ada Lovelace', 'Stripe', 0.7],
    ['b', 'Bob Builder', 'Stripe', 0.9],
    ['c', 'Cara Chen', 'Vercel', 0.5],
  ];
  for (const [id, fullName, company, score] of people) {
    await fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id,
        fullName,
        company,
        source: 'test',
        relationshipScore: score,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
  }
  await addEdge(fixture.conn, { sourceId: 'a', targetId: 'b', relation: 'colleague' }, { now: NOW });
  await addEdge(fixture.conn, { sourceId: 'b', targetId: 'c', relation: 'manual' }, { now: NOW });
});
afterAll(() => fixture.sqlite.close());

describe('getNetworkOverview.graph', () => {
  it('includes the graph section by default, sharing the overview clock', async () => {
    const o = await getNetworkOverview(fixture.conn, { now: NOW });
    expect(o.graph).toBeDefined();
    expect(o.graph!.nodes).toBe(3);
    expect(o.graph!.edges).toBe(2);
    expect(o.graph!.generatedAt).toBe(o.generatedAt);
    expect(o.graph!.components.count).toBe(1);
    // P3: one community (the path), APL = (1+2+1)/3 = 1.33.
    expect(o.graph!.avgPathLength.value).toBeCloseTo(1.33, 2);
    expect(o.clusters).toHaveLength(2); // attribute clusters still ship alongside
  });

  it('is omitted with includeGraph: false (cheap overview for API clients)', async () => {
    const o = await getNetworkOverview(fixture.conn, { now: NOW, includeGraph: false });
    expect(o.graph).toBeUndefined();
    expect(o.metrics.totalContacts).toBe(3);
  });

  it('forwards graph filters without touching the other sections', async () => {
    const pending = await addEdge(
      fixture.conn,
      { sourceId: 'a', targetId: 'c', relation: 'mutual_network', source: 'linkedin_csv' },
      { now: NOW }
    );
    expect(pending.edge.status).toBe('pending');

    const confirmedOnly = await getNetworkOverview(fixture.conn, { now: NOW });
    expect(confirmedOnly.graph!.edges).toBe(2);
    expect(confirmedOnly.graph!.pendingCandidates).toBe(1);

    const all = await getNetworkOverview(fixture.conn, { now: NOW, graph: { status: 'all' } });
    expect(all.graph!.edges).toBe(3);
    expect(all.metrics.totalContacts).toBe(3);

    const rel = await getNetworkOverview(fixture.conn, { now: NOW, graph: { relation: 'colleague' } });
    expect(rel.graph!.edges).toBe(1);
  });

  it('empty databases get an empty-state graph, not null', async () => {
    const fresh = createTestSqliteConn();
    const o = await getNetworkOverview(fresh.conn, { now: NOW });
    expect(o.graph).toMatchObject({ nodes: 0, edges: 0, coverage: 0, degraded: null });
    expect(o.graph!.warmIntros).toEqual([]);
    fresh.sqlite.close();
  });
});
