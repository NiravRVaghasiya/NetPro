// Pathfinder tests. shortestPaths runs on synthetic LoadedGraphs; the DB-side
// findIntroPaths is exercised against the migrated fixture so provenance
// (pending vs confirmed, confidence, soft-deletes) is enforced at the SQL
// filter, not in JS.
import { afterAll, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { findIntroPaths, shortestPaths } from './paths';
import { GraphError } from './types';
import { graphOf } from './testing-helpers';
import { addEdge } from './edges';

const NOW = new Date('2026-09-07T12:00:00Z');

function line(ids: string[]): Array<[string, string]> {
  return ids.slice(1).map((id, i) => [ids[i]!, id] as [string, string]);
}

describe('shortestPaths (pure BFS)', () => {
  it('finds the direct connection at 1 hop', () => {
    const g = graphOf(['a', 'b'], [['a', 'b']]);
    expect(shortestPaths(g, 'a', 'b', 4)).toEqual([['a', 'b']]);
  });

  it('finds the 2-hop chain through the only intermediary', () => {
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(shortestPaths(g, 'a', 'c', 4)).toEqual([['a', 'b', 'c']]);
  });

  it('returns nothing for disconnected graphs', () => {
    const g = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]);
    expect(shortestPaths(g, 'a', 'c', 4)).toEqual([]);
  });

  it('honors the max-depth cutoff', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const g = graphOf(ids, line(ids));
    expect(shortestPaths(g, 'a', 'e', 3)).toEqual([]);
    expect(shortestPaths(g, 'a', 'e', 4)).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  it('respects edge direction for one-way rows', () => {
    const g = graphOf(['a', 'b'], [{ sourceId: 'a', targetId: 'b', bidirectional: false }]);
    expect(shortestPaths(g, 'a', 'b', 4)).toEqual([['a', 'b']]);
    expect(shortestPaths(g, 'b', 'a', 4)).toEqual([]);
  });

  it('enumerates k equal-length alternatives deterministically', () => {
    const g = graphOf(['a', 'b', 'c', 'x'], [['a', 'b'], ['a', 'c'], ['b', 'x'], ['c', 'x']]);
    expect(shortestPaths(g, 'a', 'x', 4, 2)).toEqual([['a', 'b', 'x'], ['a', 'c', 'x']]);
    expect(shortestPaths(g, 'a', 'x', 4, 1)).toEqual([['a', 'b', 'x']]); // first by id order
    expect(shortestPaths(g, 'a', 'x', 4, 9)).toEqual([['a', 'b', 'x'], ['a', 'c', 'x']]); // capped
  });

  it('traverses bidirectional rows in BOTH directions (regression: out-list copies)', () => {
    const g = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(shortestPaths(g, 'c', 'a', 4)).toEqual([['c', 'b', 'a']]);
  });

  it('refuses degenerate queries', () => {
    const g = graphOf(['a', 'b'], [['a', 'b']]);
    expect(shortestPaths(g, 'a', 'a', 4)).toEqual([]);
    expect(shortestPaths(g, 'a', 'ghost', 4)).toEqual([]);
    expect(shortestPaths(g, 'ghost', 'a', 4)).toEqual([]);
  });

  it('prefers shorter chains over same-hop detours', () => {
    // a–x direct AND a–b–x: only the 1-hop path is returned.
    const g = graphOf(['a', 'b', 'x'], [['a', 'x'], ['a', 'b'], ['b', 'x']]);
    expect(shortestPaths(g, 'a', 'x', 4, 3)).toEqual([['a', 'x']]);
  });
});

describe('findIntroPaths (DB)', () => {
  const fixture = createTestSqliteConn();

  async function seed(contacts: Array<[string, string]>, edges: Parameters<typeof addEdge>[1][] = []) {
    fixture.sqlite.exec('DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;');
    for (const [id, fullName] of contacts) {
      await fixture.conn.db
        .insert(fixture.conn.schema.contacts)
        .values({ id, fullName, source: 'test', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    }
    for (const e of edges) {
      await addEdge(fixture.conn, e, { now: NOW });
    }
  }

  afterAll(() => fixture.sqlite.close());

  it('walks a confirmed chain and annotates each hop', async () => {
    await seed(
      [['a', 'Ada'], ['b', 'Bob'], ['c', 'Cara']],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' },
        { sourceId: 'b', targetId: 'c', relation: 'met_at_event' },
      ]
    );

    const res = await findIntroPaths(fixture.conn, 'a', 'c');
    expect(res.found).toBe(true);
    expect(res.paths).toHaveLength(1);
    const path = res.paths[0]!;
    expect(path.hops).toBe(2);
    expect(path.intermediaries.map((n) => n.contactId)).toEqual(['b']);
    expect(path.path[1]!.via).toMatchObject({ relations: ['colleague'], oneWay: false });
    expect(path.path[1]!.via!.minConfidence).toBe(1);
    expect(path.path[0]!.via).toBeNull();
    expect(path.path[2]!.fullName).toBe('Cara');
  });

  it('excludes pending edges by default and includes them via status=all', async () => {
    await seed(
      [['a', 'Ada'], ['b', 'Bob']],
      [{ sourceId: 'a', targetId: 'b', relation: 'mutual_network', source: 'linkedin_csv' }]
    ); // inferred → pending

    const blocked = await findIntroPaths(fixture.conn, 'a', 'b');
    expect(blocked.found).toBe(false);
    expect(blocked.unreachable).toBe(true);

    const allowed = await findIntroPaths(fixture.conn, 'a', 'b', { status: 'all' });
    expect(allowed.found).toBe(true);
    expect(allowed.paths[0]!.path.map((n) => n.contactId)).toEqual(['a', 'b']);
  });

  it('applies relation and min-confidence filters', async () => {
    await seed(
      [['a', 'Ada'], ['b', 'Bob'], ['d', 'Dan']],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' },
        { sourceId: 'b', targetId: 'd', relation: 'mutual_intro', confidence: 0.4 },
      ]
    );
    expect((await findIntroPaths(fixture.conn, 'a', 'd')).found).toBe(true);
    expect((await findIntroPaths(fixture.conn, 'a', 'd', { relation: 'colleague' })).found).toBe(false);
    expect((await findIntroPaths(fixture.conn, 'a', 'd', { minConfidence: 0.5 })).found).toBe(false);
    expect((await findIntroPaths(fixture.conn, 'a', 'd', { maxDepth: 1 })).found).toBe(false);
  });

  it('uses confirmed edges symmetrically, one-way rows asymmetrically', async () => {
    await seed(
      [['a', 'Ada'], ['b', 'Bob'], ['c', 'Cara']],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' }, // bidirectional default
        { sourceId: 'b', targetId: 'c', relation: 'manual', bidirectional: false },
      ]
    );
    expect((await findIntroPaths(fixture.conn, 'b', 'a')).paths[0]!.path.map((n) => n.contactId)).toEqual([
      'b',
      'a',
    ]);
    expect((await findIntroPaths(fixture.conn, 'a', 'c')).found).toBe(true);
    expect((await findIntroPaths(fixture.conn, 'c', 'b')).found).toBe(false); // one-way, backward
    const via = await findIntroPaths(fixture.conn, 'c', 'a');
    expect(via.found).toBe(false); // cannot even reach the one-way start backward
  });

  it('marks one-way traversal on the hop', async () => {
    await seed([['a', 'Ada'], ['b', 'Bob']]);
    await fixture.conn.db.insert(fixture.conn.schema.edges).values({
      id: 'one-way-1',
      sourceId: 'a',
      targetId: 'b',
      relation: 'manual',
      strength: 0.5,
      context: null,
      bidirectional: false,
      source: 'manual',
      confidence: 1,
      status: 'confirmed',
      discoveredAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const forward = await findIntroPaths(fixture.conn, 'a', 'b');
    expect(forward.paths[0]!.path[1]!.via).toMatchObject({ oneWay: true });
    const backward = await findIntroPaths(fixture.conn, 'b', 'a');
    expect(backward.found).toBe(false);
  });

  it('will not route through a soft-deleted contact', async () => {
    await seed(
      [['a', 'Ada'], ['dead', 'Deleted Dana'], ['d', 'Dan']],
      [
        { sourceId: 'a', targetId: 'dead' },
        { sourceId: 'dead', targetId: 'd' },
      ]
    );
    fixture.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), 'dead');
    const res = await findIntroPaths(fixture.conn, 'a', 'd');
    expect(res.found).toBe(false);
    expect(res.paths).toHaveLength(0);
  });

  it('rejects same-endpoint and unknown-contact queries with structured errors', async () => {
    await seed([['a', 'Ada']]);
    await expect(findIntroPaths(fixture.conn, 'a', 'a')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(findIntroPaths(fixture.conn, 'a', 'nope')).rejects.toBeInstanceOf(GraphError);
    await expect(findIntroPaths(fixture.conn, 'a', 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(findIntroPaths(fixture.conn, 'a', '')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
