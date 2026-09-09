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
  fixture.sqlite.exec(
    'DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM profile_views; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;'
  );
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

describe('/dashboard Profile views (v2.5 phase 3)', () => {
  function insertViews() {
    const rows = [
      { id: 'w1', referrer: 'https://blog.example/hello', country: 'GB', contact: 'a' },
      { id: 'w2', referrer: null, country: null, contact: null },
    ];
    for (const [i, r] of rows.entries()) {
      fixture.conn.db
        .insert(fixture.conn.schema.profileViews)
        .values({
          id: r.id,
          viewerIp: `3${i}23456789abcdef`,
          viewerFingerprint: `c3${i}23456789abcde`,
          isBot: false,
          isOwnerView: false,
          sessionId: `sess-${r.id}`,
          viewedPage: '/card',
          viewedAt: NOW,
          referrer: r.referrer,
          country: r.country,
          resolvedContact: r.contact,
        })
        .run();
    }
  }

  it('shows the onboarding empty state until the card gets views', async () => {
    insertContacts();
    const html = await render();
    expect(html).toContain('Profile views');
    expect(html).toContain('No views in the last 30 days yet');
    expect(html).toContain('/settings/card');
  });

  it('renders totals, sparkline, referrers, and recent views with contact links', async () => {
    insertContacts();
    insertViews();
    const html = await render();
    expect(html).toContain('2 views · 2 unique viewers · 1 known-visitor view');
    expect(html).toContain('Profile views per day');
    expect(html).toContain('Top referrers');
    expect(html).toContain('blog.example');
    expect(html).toContain('Recent views');
    expect(html).toContain('/contacts/a');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('anonymous');
  });
});

describe('/dashboard Content strip (v2.5 Phase 5 + 6)', () => {
  it('shows the "Add your first content" onboarding step until content is tracked', async () => {
    insertContacts();
    const html = await render();
    expect(html).toContain('<h2>Content</h2>');
    expect(html).toContain('No content tracked yet');
    expect(html).toContain('Add your first content');
    expect(html).toContain('href="/content"');
    expect(html).not.toContain('latest-known views');
  });

  it('renders the tracker totals, the top pieces and the platform mix once items exist', async () => {
    insertContacts();
    const { upsertContentItem, recordMetrics } = await import('@netpro/core/src/content');
    const seeded = [
      { url: 'https://example.dev/blog/one', title: 'The first post', platform: 'blog', publishedAt: NOW },
      { url: 'https://example.dev/blog/two', title: 'The second post', platform: 'blog', publishedAt: NOW },
      { url: 'https://dev.to/ada/three', title: 'A devto post', platform: 'devto', publishedAt: NOW },
    ];
    const ids: string[] = [];
    for (const s of seeded) {
      const { item } = await upsertContentItem(
        fixture.conn,
        { url: s.url, title: s.title, platform: s.platform, publishedAt: s.publishedAt },
        { now: new Date(NOW) }
      );
      ids.push(item.id);
    }
    // A minute apart so "latest" is deterministic — ties fall back to id.
    await recordMetrics(
      fixture.conn,
      { contentId: ids[0]!, views: 100, likes: 2 },
      { now: new Date(NOW) }
    );
    await recordMetrics(
      fixture.conn,
      { contentId: ids[0]!, views: 1200, likes: 40 },
      { now: new Date('2026-09-07T12:01:00Z') }
    );
    const html = await render();
    expect(html).toContain('<h2>Content</h2>');
    expect(html).toContain('3 items · 1 measured · 1,200 latest-known views · 2 on Blog, 1 on dev.to.');
    expect(html).toContain('The first post');
    expect(html).toContain(`href="/content/${ids[0]}"`);
    // Top pieces are ranked by latest-known views; unmeasured rows are absent.
    expect(html).toContain('· 1,200 views');
    expect(html).not.toContain('A devto post');
    expect(html).toContain('Open the tracker');
  });
});
