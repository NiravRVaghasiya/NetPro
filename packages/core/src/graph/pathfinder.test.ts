// v2.0 Phase 3 surface-engine tests: hand-checked ranking math, ask
// selection, default origin, selector→GraphError mapping, and the composer
// prefill text. All offline on the migrated SQLite fixture.
//
// A chain's `via` is set on every node EXCEPT the origin (one per hop), so
// avgHopStrength averages over path.path.slice(1). Hand-check each number.
import { afterAll, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addEdge } from './edges';
import {
  buildIntroAskInput,
  defaultPathOrigin,
  introAskText,
  planIntroPaths,
  rankIntroPaths,
  scoreIntroPath,
} from './pathfinder';
import { GraphError } from './types';
import type { IntroPath } from './paths';

const NOW = new Date('2026-09-07T12:00:00Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

function node(
  id: string,
  score: number | null,
  via?: [number, number],
  last?: string | null
) {
  return {
    contactId: id,
    fullName: `Name ${id}`,
    company: null,
    role: null,
    relationshipScore: score,
    lastInteraction: last ?? null,
    via: via ? { relations: ['colleague'], minStrength: via[0], minConfidence: via[1], oneWay: false } : null,
  };
}
function path(nodes: ReturnType<typeof node>[]): IntroPath {
  return { hops: nodes.length - 1, path: nodes, intermediaries: nodes.slice(1, -1) } as unknown as IntroPath;
}

describe('scoreIntroPath (hand-computed)', () => {
  it('scores a 2-hop chain by weakest tie and hop strength', () => {
    // askable = {origin a 0.9, intermediary b 0.4} → weakestTie 0.4
    // hops: a→b (0.5·1=0.5), b→z (0.5·1=0.5) → avg 0.5
    // score = 0.6·0.4 + 0.4·0.5 = 0.44
    const p = path([node('a', 0.9), node('b', 0.4, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    expect(scoreIntroPath(p)).toEqual({ weakestTie: 0.4, avgHopStrength: 0.5, score: 0.44 });
  });

  it('treats a null score as 0 and a direct hop as "no weak link"', () => {
    const nullTie = path([node('a', null), node('b', null, [1, 1]), node('z', null, [1, 1])]);
    expect(scoreIntroPath(nullTie)).toEqual({ weakestTie: 0, avgHopStrength: 1, score: 0.4 });
    // direct (1 hop): tie term is 1, only hop is a→z (0.5·1)
    const direct = path([node('a', 0.2), node('z', 0.9, [0.5, 1])]);
    expect(scoreIntroPath(direct)).toEqual({ weakestTie: null, avgHopStrength: 0.5, score: 0.8 });
  });

  it('averages hop strength over multi-hop chains', () => {
    // askable {a 0.7, b 0.6, c 0.9} → weakest 0.6
    // hops: (0.5·1)+(0.8·0.5)=0.4 … avg of [0.5,0.4,?]: b .5, c .4, z .2 → (0.5+0.4+0.2)/3 = 0.3666→0.367
    // score = 0.6·0.6 + 0.4·0.367 = 0.5067… → round3 0.507
    const p = path([node('a', 0.7), node('b', 0.6, [0.5, 1]), node('c', 0.9, [0.8, 0.5]), node('z', 0.1, [0.4, 0.5])]);
    expect(scoreIntroPath(p)).toEqual({ weakestTie: 0.6, avgHopStrength: 0.367, score: 0.507 });
  });
});

describe('rankIntroPaths', () => {
  it('ranks the stronger-tie chain first', () => {
    const weak = path([node('a', 0.9), node('b', 0.4, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    const strong = path([node('a', 0.9), node('c', 0.8, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    const ranked = rankIntroPaths([weak, strong]);
    expect(ranked.map((p) => p.rank)).toEqual([1, 2]);
    expect(ranked[0]!.path.map((n) => n.contactId)).toEqual(['a', 'c', 'z']);
    // strong: weakest tie min(0.9,0.8)=0.8 → 0.6·0.8+0.4·0.5 = 0.68 ; weak 0.44
    expect(ranked[0]!.score.score).toBe(0.68);
    expect(ranked[1]!.score.score).toBe(0.44);
  });

  it('breaks score ties by the lexicographically smallest id chain', () => {
    const viaC = path([node('a', 0.9), node('c', 0.4, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    const viaB = path([node('a', 0.9), node('b', 0.4, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    expect(rankIntroPaths([viaC, viaB])[0]!.path.map((n) => n.contactId)).toEqual(['a', 'b', 'z']);
  });
});

describe('ask selection', () => {
  it('picks the strongest askable node (not necessarily the origin)', () => {
    // origin a(0.2) → b(0.9) → z: b is the strongest askable → ask b, adjacent to z.
    const strong = path([node('a', 0.2), node('b', 0.9, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    const ranked = rankIntroPaths([strong]);
    expect(ranked[0]!.ask.contactId).toBe('b');
    expect(ranked[0]!.ask.askForId).toBe('z');
    expect(ranked[0]!.ask.adjacentToTarget).toBe(true);
    expect(ranked[0]!.ask.suggestion).toContain('introduction to Name z');
  });

  it('when origin is strongest, asks the origin to bridge toward the target', () => {
    // a(0.9) → b(0.1) → c(0.2) → z: strongest askable is a; a is NOT adjacent to z.
    const p = path([node('a', 0.9), node('b', 0.1, [0.5, 1]), node('c', 0.2, [0.5, 1]), node('z', 0.1, [0.5, 1])]);
    const ranked = rankIntroPaths([p]);
    expect(ranked[0]!.ask.contactId).toBe('a');
    expect(ranked[0]!.ask.askForId).toBe('b');
    expect(ranked[0]!.ask.adjacentToTarget).toBe(false);
    expect(ranked[0]!.ask.suggestion).toContain('connect you with Name b');
    expect(ranked[0]!.ask.suggestion).toContain('2 more hops');
  });
});

// ── DB-backed: default origin, selector mapping, plan + drafting ─────────────

const db = createTestSqliteConn();

interface SeedContact {
  id: string;
  fullName: string;
  score?: number | null;
  last?: string | null;
  company?: string | null;
  role?: string | null;
  email?: string | null;
  deleted?: boolean;
}

async function seed(contacts: SeedContact[], edges: Parameters<typeof addEdge>[1][] = []) {
  db.sqlite.exec(
    'DELETE FROM event_attendees; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
  for (const c of contacts) {
    await db.conn.db.insert(db.conn.schema.contacts).values({
      id: c.id,
      fullName: c.fullName,
      email: c.email ?? null,
      company: c.company ?? null,
      role: c.role ?? null,
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

afterAll(() => db.sqlite.close());

/** Ada(0.9) — Bob(0.4) / Cara(0.8) both connect to Zoe; Bob is NOT adjacent to Zoe. */
async function diamond() {
  await seed(
    [
      { id: 'a', fullName: 'Ada Lovelace', score: 0.9, last: iso(5), company: 'Analytical Engines', role: 'Founder', email: 'ada@engines.dev' },
      { id: 'b', fullName: 'Bob', score: 0.4, last: null },
      { id: 'c', fullName: 'Cara', score: 0.8, last: iso(40) },
      { id: 'z', fullName: 'Zoe Target', score: 0.1, last: iso(500), company: 'Acme', role: 'CTO' },
    ],
    [
      { sourceId: 'a', targetId: 'b', relation: 'colleague' },
      { sourceId: 'a', targetId: 'c', relation: 'colleague' },
      { sourceId: 'c', targetId: 'z', relation: 'met_at_event' },
    ]
  );
}

describe('defaultPathOrigin', () => {
  it('picks the highest relationshipScore, then most recent, then id', async () => {
    await seed([
      { id: 'a', fullName: 'Ada', score: 0.5, last: iso(50) },
      { id: 'b', fullName: 'Bob', score: 0.9, last: iso(999) },
      { id: 'c', fullName: 'Cara', score: 0.5, last: iso(10) },
      { id: 'd', fullName: 'Dan', score: null },
    ]);
    expect((await defaultPathOrigin(db.conn))!.id).toBe('b');
  });

  it('ties resolve by recency then id, and skip soft-deleted rows', async () => {
    await seed([
      { id: 'a', fullName: 'Ada', score: 0.5, last: iso(200) },
      { id: 'c', fullName: 'Cara', score: 0.5, last: iso(2) },
      { id: 'z', fullName: 'Zoe Deleted', score: 1, deleted: true },
    ]);
    expect((await defaultPathOrigin(db.conn))!.id).toBe('c');
  });

  it('returns null on an empty database', async () => {
    await seed([]);
    expect(await defaultPathOrigin(db.conn)).toBeNull();
  });
});

describe('planIntroPaths', () => {
  it('plans the ranked chain with origin metadata and ask suggestion', async () => {
    await diamond();
    const plan = await planIntroPaths(db.conn, { target: 'Zoe Target', from: 'Ada Lovelace', k: 2 });
    expect(plan.origin.selectedBy).toBe('explicit');
    expect(plan.origin.relationshipScore).toBe(0.9);
    expect(plan.target.fullName).toBe('Zoe Target');
    expect(plan.found).toBe(true);
    // Bob cannot reach Zoe within depth 4 either — he hangs off Ada only.
    expect(plan.paths).toHaveLength(1);
    const top = plan.paths[0]!;
    expect(top.path.map((n) => n.contactId)).toEqual(['a', 'c', 'z']);
    expect(top.hops).toBe(2);
    // weakest tie min(0.9, 0.8) = 0.8; hops 0.5 each → 0.6*0.8 + 0.4*0.5 = 0.68
    expect(top.score.score).toBe(0.68);
    expect(top.ask.contactId).toBe('a'); // 0.9 beats Cara 0.8
    expect(top.ask.askForId).toBe('c');
    expect(top.ask.adjacentToTarget).toBe(false);
  });

  it('defaults the origin to the strongest tie and says so', async () => {
    await diamond();
    const plan = await planIntroPaths(db.conn, { target: 'Zoe Target' });
    expect(plan.origin.contactId).toBe('a');
    expect(plan.origin.selectedBy).toBe('strongest-tie');
    expect(plan.found).toBe(true);
  });

  it('skips the target when it would otherwise be its own origin (smoke-caught)', async () => {
    // Uniform scores + recency ordering used to make the freshest contact
    // (here: the target) the default origin → "same contact" error.
    await seed(
      [
        { id: 'a', fullName: 'Ada', score: 0, last: iso(100) },
        { id: 'z', fullName: 'Zoe', score: 0, last: iso(1) }, // freshest — would win
      ],
      [{ sourceId: 'a', targetId: 'z' }]
    );
    const plan = await planIntroPaths(db.conn, { target: 'z' });
    expect(plan.origin.contactId).toBe('a'); // fell to the runner-up tie
    expect(plan.origin.selectedBy).toBe('strongest-tie');
    expect(plan.found).toBe(true);
    // A lone contact cannot chain to itself — a clear not_found instead.
    await seed([{ id: 'z', fullName: 'Zoe', score: 0 }]);
    await expect(planIntroPaths(db.conn, { target: 'z' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports unreachable pairs honestly and respects depth caps', async () => {
    await diamond();
    const nope = await planIntroPaths(db.conn, { target: 'Zoe Target', from: 'Bob' }, { maxDepth: 1 });
    expect(nope.found).toBe(false);
    expect(nope.unreachable).toBe(true);
    expect(nope.paths).toEqual([]);
    const deep = await planIntroPaths(db.conn, { target: 'Zoe Target', from: 'Bob' }, { maxDepth: 3 });
    expect(deep.found).toBe(true); // bob → ada → cara → zoe
    expect(deep.paths[0]!.path.map((n) => n.contactId)).toEqual(['b', 'a', 'c', 'z']);
  });

  it('maps unknown and ambiguous selectors to GraphError codes', async () => {
    await seed([
      { id: 'a', fullName: 'Sam Name', score: 0.9 },
      { id: 'b', fullName: 'Sam Name', score: 0.5 },
      { id: 'c', fullName: 'Alone', score: 0.2 },
    ]);
    await expect(planIntroPaths(db.conn, { target: 'Ghost', from: 'Alone' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('Target:'),
    });
    await expect(planIntroPaths(db.conn, { target: 'Sam Name', from: 'Alone' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('rejects same-origin plans and missing targets', async () => {
    await diamond();
    await expect(planIntroPaths(db.conn, { target: 'ada@engines.dev', from: 'Ada Lovelace' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(planIntroPaths(db.conn, { target: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await seed([]);
    await expect(planIntroPaths(db.conn, { target: 'Ghost' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('excludes pending candidates from paths unless status=all', async () => {
    await seed(
      [
        { id: 'a', fullName: 'Ada', score: 0.9 },
        { id: 'b', fullName: 'Bob', score: 0.5 },
        { id: 'z', fullName: 'Zoe', score: 0.1 },
      ],
      [
        { sourceId: 'a', targetId: 'b', relation: 'colleague' },
        { sourceId: 'b', targetId: 'z', relation: 'mutual_network', source: 'linkedin_csv' }, // inferred → pending
      ]
    );
    expect((await planIntroPaths(db.conn, { target: 'Zoe', from: 'Ada' })).found).toBe(false);
    expect((await planIntroPaths(db.conn, { target: 'Zoe', from: 'Ada' }, { status: 'all' })).found).toBe(true);
  });

  it('propagates graph option validation from the engine (bad relation)', async () => {
    await diamond();
    await expect(planIntroPaths(db.conn, { target: 'Zoe Target' }, { relation: 'telepathy' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('composer prefill + draft input', () => {
  async function planForDraft() {
    await seed(
      [
        { id: 'a', fullName: 'Ada Lovelace', score: 0.9, last: iso(5), company: 'Engines', role: 'Founder', email: 'ada@engines.dev' },
        { id: 'z', fullName: 'Zoe Target', company: 'Acme', role: 'CTO', score: 0.1 },
      ],
      [{ sourceId: 'a', targetId: 'z', relation: 'colleague', context: 'React Conf mutual' }]
    );
    return planIntroPaths(db.conn, { target: 'z', from: 'a' });
  }

  it('introAskText describes the chain, recency and the ask — deterministically', async () => {
    const plan = await planForDraft();
    const text = introAskText(plan, plan.paths[0]!);
    expect(text.context).toContain('Ada Lovelace → Zoe Target');
    expect(text.context).toContain('1 hop');
    expect(text.context).toContain('directly connected to Zoe Target');
    expect(text.purpose).toContain('an introduction to Zoe Target (CTO at Acme)');
    expect(introAskText(plan, plan.paths[0]!).context).toBe(text.context); // stable
  });

  it('clips context to the compose cap without crashing on absurd names', async () => {
    const longName = 'L'.repeat(300);
    await seed(
      [
        { id: 'a', fullName: longName, score: 0.5 },
        { id: 'z', fullName: 'Zoe', score: 0.1 },
      ],
      [{ sourceId: 'a', targetId: 'z' }]
    );
    const plan = await planIntroPaths(db.conn, { target: 'z', from: 'a' });
    expect(introAskText(plan, plan.paths[0]!).context.length).toBeLessThanOrEqual(2000);
  });

  it('buildIntroAskInput personalizes to the LIVE profile of the person being asked', async () => {
    const plan = await planForDraft();
    const input = await buildIntroAskInput(db.conn, plan, plan.paths[0]!, { senderName: 'Nirav' });
    expect(input.recipient.name).toBe('Ada Lovelace');
    expect(input.recipient.email).toBe('ada@engines.dev');
    expect(input.tone).toBe('warm');
    expect(input.senderName).toBe('Nirav');
    expect(input.purpose).toContain('Zoe Target');
  });

  it('buildIntroAskInput errors when the ask contact vanished', async () => {
    const plan = await planForDraft();
    const stale = structuredClone(plan) as typeof plan;
    stale.paths[0]!.ask.contactId = 'gone';
    await expect(buildIntroAskInput(db.conn, stale, stale.paths[0]!)).rejects.toBeInstanceOf(GraphError);
  });
});
