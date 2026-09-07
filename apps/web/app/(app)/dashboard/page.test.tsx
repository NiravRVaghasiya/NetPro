// /dashboard render tests for the v2.0 Phase 2 "Network graph" strip:
// the empty state until edges exist, the full section once they do.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));

import DashboardPage from './page';

const NOW = new Date('2026-09-07T12:00:00Z').toISOString();

async function render(): Promise<string> {
  const element = await DashboardPage();
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

function insertContacts() {
  for (const [id, name] of [
    ['a', 'Ada Lovelace'],
    ['b', 'Bob Builder'],
    ['c', 'Cara Chen'],
    ['d', 'Dan Delta'],
  ] as const) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id,
        fullName: name,
        source: 'test',
        relationshipScore: id === 'b' ? 0.9 : 0.3,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
}

beforeAll(() => {
  // Deterministic clock everywhere below: seed dates match "now".
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
});
afterEach(() => {
  fixture.sqlite.exec('DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;');
});
afterAll(() => {
  vi.useRealTimers();
  fixture.sqlite.close();
});

describe('/dashboard Network graph', () => {
  it('shows the onboarding empty state when no edges exist', async () => {
    insertContacts();
    const html = await render();
    expect(html).toContain('Network graph');
    expect(html).toContain('No confirmed edges yet');
    expect(html).toContain('/edges');
  });

  it('renders communities, centrality, and warm-intro candidates from confirmed edges', async () => {
    insertContacts();
    for (const [id, s, t] of [
      ['e1', 'a', 'b'],
      ['e2', 'b', 'c'],
      ['e3', 'c', 'a'],
      ['e4', 'b', 'd'],
      ['e5', 'd', 'a'], // pending candidate — must stay out of the analysis
    ] as const) {
      fixture.conn.db
        .insert(fixture.conn.schema.edges)
        .values({
          id,
          sourceId: s,
          targetId: t,
          relation: 'manual',
          strength: 0.5,
          bidirectional: true,
          source: id === 'e5' ? 'linkedin_csv' : 'manual',
          confidence: id === 'e5' ? 0.5 : 1,
          status: id === 'e5' ? 'pending' : 'confirmed',
          discoveredAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }

    const html = await render();
    expect(html).toContain('4 of 4 contacts linked by 4 confirmed edges');
    expect(html).toContain('Communities');
    expect(html).toContain('modularity');
    expect(html).toContain('Most connected');
    expect(html).toContain('Bob Builder');
    expect(html).toContain('betweenness');
    expect(html).toContain('Warm-intro candidates');
    expect(html).toContain('excluded from the analysis until you confirm them');
  });

  it('keeps the pending candidate visible but out of the analysis', async () => {
    insertContacts();
    fixture.conn.db
      .insert(fixture.conn.schema.edges)
      .values({
        id: 'p1',
        sourceId: 'a',
        targetId: 'd',
        relation: 'mutual_network',
        strength: 0.5,
        bidirectional: true,
        source: 'linkedin_csv',
        confidence: 0.5,
        status: 'pending',
        discoveredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const html = await render();
    expect(html).toContain('No confirmed edges yet');
    expect(html).toContain('1 pending candidate');
    expect(html).toContain('/edges?status=pending');
  });
});
