import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  addEdge,
  countEdges,
  GraphError,
  ingestMutualCandidates,
  importEdgesCsv,
  listEdges,
  mergeSymmetricPairs,
  recordEventAttendance,
  removeEdge,
  setEdgeStatus,
  validateConfidence,
} from './index';

const fixture = createTestSqliteConn();
const now = new Date('2026-09-07T12:00:00Z');

function seed(id: string, name: string, extra: Record<string, unknown> = {}) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName: name,
      email: `${id}@example.com`,
      source: 'test',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...extra,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  seed('a', 'Ada Lovelace');
  seed('b', 'Bob Builder');
  seed('c', 'Cara Chen');
});
afterAll(() => fixture.sqlite.close());

describe('addEdge', () => {
  it('inserts a confirmed manual edge with canonical order', async () => {
    const { edge, created } = await addEdge(
      fixture.conn,
      { sourceId: 'b', targetId: 'a', relation: 'colleague' },
      { now }
    );
    expect(created).toBe(true);
    expect(edge.sourceId).toBe('a');
    expect(edge.targetId).toBe('b');
    expect(edge.status).toBe('confirmed');
    expect(edge.source).toBe('manual');
    expect(edge.confidence).toBe(1);
    expect(edge.relation).toBe('colleague');
  });

  it('rejects self-edges, unknown relations, and missing contacts', async () => {
    await expect(addEdge(fixture.conn, { sourceId: 'a', targetId: 'a' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      addEdge(fixture.conn, { sourceId: 'a', targetId: 'b', relation: 'besties' })
    ).rejects.toBeInstanceOf(GraphError);
    await expect(addEdge(fixture.conn, { sourceId: 'a', targetId: 'zzz' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects soft-deleted contacts', async () => {
    fixture.sqlite
      .prepare("UPDATE contacts SET deleted_at = ? WHERE id = 'b'")
      .run(now.toISOString());
    await expect(addEdge(fixture.conn, { sourceId: 'a', targetId: 'b' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('dedupes symmetric pairs as a conflict unless merge is set', async () => {
    await addEdge(fixture.conn, { sourceId: 'a', targetId: 'b' }, { now });
    await expect(addEdge(fixture.conn, { sourceId: 'b', targetId: 'a' }, { now })).rejects.toMatchObject({
      code: 'conflict',
    });
    const merged = await addEdge(
      fixture.conn,
      { sourceId: 'b', targetId: 'a', relation: 'mutual_intro' },
      { now, merge: true }
    );
    expect(merged.created).toBe(false);
    expect(merged.edge.relation).toBe('mutual_intro');
    expect(await countEdges(fixture.conn)).toBe(1);
  });

  it('weights confidence in [0,1]', () => {
    expect(validateConfidence(0.4)).toBe(0.4);
    expect(() => validateConfidence(1.5)).toThrow(/confidence/);
  });
});

describe('list / confirm / remove', () => {
  it('lists with names, confirms pending, and undoes', async () => {
    await addEdge(
      fixture.conn,
      {
        sourceId: 'a',
        targetId: 'b',
        relation: 'mutual_network',
        source: 'linkedin_csv',
        status: 'pending',
        confidence: 0.4,
      },
      { now }
    );
    const listed = await listEdges(fixture.conn, { status: 'pending' });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.sourceName).toBe('Ada Lovelace');
    expect(listed[0]!.targetName).toBe('Bob Builder');

    const confirmed = await setEdgeStatus(fixture.conn, listed[0]!.id, 'confirmed', { now });
    expect(confirmed.status).toBe('confirmed');

    await removeEdge(fixture.conn, listed[0]!.id);
    expect(await countEdges(fixture.conn)).toBe(0);
  });
});

describe('mergeSymmetricPairs', () => {
  it('collapses A→B and B→A into one row', async () => {
    await addEdge(
      fixture.conn,
      { sourceId: 'a', targetId: 'b', bidirectional: false },
      { now }
    );
    // Force a reverse row past canonicalization by inserting directly.
    fixture.conn.db
      .insert(fixture.conn.schema.edges)
      .values({
        id: 'rev',
        sourceId: 'b',
        targetId: 'a',
        relation: 'manual',
        source: 'manual',
        status: 'confirmed',
        confidence: 1,
        strength: 0.5,
        bidirectional: false,
        discoveredAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();
    const { merged } = await mergeSymmetricPairs(fixture.conn);
    expect(merged).toBe(1);
    expect(await countEdges(fixture.conn)).toBe(1);
  });
});

describe('ingestMutualCandidates', () => {
  it('inserts pending mutual_network edges, never confirmed', async () => {
    const csv = [
      'First Name,Last Name,Email Address,Mutual Connections',
      'Ada,Lovelace,a@example.com,"Bob Builder, Cara Chen"',
    ].join('\n');
    const summary = await ingestMutualCandidates(fixture.conn, csv, { now });
    expect(summary.inserted).toBe(2);
    const rows = await listEdges(fixture.conn);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.relation === 'mutual_network')).toBe(true);
    expect(rows.every((r) => r.confidence < 1)).toBe(true);
  });
});

describe('importEdgesCsv', () => {
  it('imports a two-column file of selectors', async () => {
    const csv = ['from,to', 'Ada Lovelace,Bob Builder', 'a@example.com,Cara Chen'].join('\n');
    const summary = await importEdgesCsv(fixture.conn, csv, { now });
    expect(summary.imported).toBe(2);
    expect(summary.errors).toEqual([]);
  });
});

describe('recordEventAttendance', () => {
  it('creates event + attendee + met_at_event edges to existing attendees', async () => {
    await recordEventAttendance(fixture.conn, { contactId: 'a', eventName: 'React Conf' }, { now });
    const second = await recordEventAttendance(
      fixture.conn,
      { contactId: 'b', eventName: 'React Conf' },
      { now }
    );
    expect(second.linked).toBe(1);
    const edges = await listEdges(fixture.conn, { relation: 'met_at_event' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.status).toBe('confirmed');
  });
});
