import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  executeEdgeAdd,
  executeEdgeImport,
  executeEdgeList,
  executeEdgeMerge,
  executeEdgeRm,
  executeEdgeStatus,
  renderEdgeLine,
} from './edge';

const fixture = createTestSqliteConn();
const now = new Date('2026-09-07T12:00:00Z');

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM edges; DELETE FROM contacts; DELETE FROM activity_log;');
  for (const [id, name] of [
    ['a', 'Ada Lovelace'],
    ['b', 'Bob Builder'],
  ] as const) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id,
        fullName: name,
        email: `${id}@example.com`,
        source: 'test',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

describe('netpro edge', () => {
  it('adds, lists, confirms, and removes', async () => {
    const added = await executeEdgeAdd('Ada Lovelace', 'b@example.com', { relation: 'colleague' }, fixture.conn, now);
    expect(added).toMatch(/Linked Ada Lovelace ↔ Bob Builder/);
    const listed = await executeEdgeList({}, fixture.conn);
    expect(listed).toContain('Ada Lovelace ↔ Bob Builder');
    expect(listed).toContain('colleague');

    const json = JSON.parse(await executeEdgeList({ json: true }, fixture.conn)) as Array<{ id: string }>;
    const confirmed = await executeEdgeStatus(json[0]!.id.slice(0, 8), 'confirmed', {}, fixture.conn, now);
    expect(confirmed).toMatch(/confirmed/);
    const removed = await executeEdgeRm(json[0]!.id.slice(0, 8), {}, fixture.conn);
    expect(removed).toMatch(/Removed edge/);
    expect(await executeEdgeList({}, fixture.conn)).toMatch(/No edges yet/);
  });

  it('imports a two-column CSV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'netpro-edge-'));
    const path = join(dir, 'edges.csv');
    writeFileSync(path, 'from,to\nAda Lovelace,Bob Builder\n');
    const out = await executeEdgeImport(path, {}, fixture.conn, now);
    expect(out).toMatch(/Imported 1 edges/);
  });

  it('merge reports collapsed pairs', async () => {
    await executeEdgeAdd('a', 'b', {}, fixture.conn, now);
    const out = await executeEdgeMerge({}, fixture.conn);
    expect(out).toMatch(/Collapsed 0/);
  });

  it('renderEdgeLine is stable', () => {
    expect(
      renderEdgeLine({
        id: 'abcdefghij',
        sourceId: 'a',
        targetId: 'b',
        sourceName: 'Ada',
        targetName: 'Bob',
        relation: 'manual',
        strength: 0.5,
        context: null,
        bidirectional: true,
        source: 'manual',
        confidence: 1,
        status: 'confirmed',
        discoveredAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
    ).toBe('  Ada ↔ Bob · manual · confirmed  [abcdefgh]');
  });
});
