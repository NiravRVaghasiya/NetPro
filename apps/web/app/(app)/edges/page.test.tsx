import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));
vi.mock('./panels', () => ({
  EdgeActions: ({ edgeId }: { edgeId: string }) => <span data-testid={`actions-${edgeId}`} />,
  AddEdgeForm: () => <div data-testid="add-edge" />,
}));

import EdgesPage from './page';

const NOW = new Date('2026-09-07T12:00:00Z').toISOString();

async function render(status?: string): Promise<string> {
  const element = await EdgesPage({
    searchParams: Promise.resolve(status ? { status } : {}),
  });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  fixture.sqlite.exec('DELETE FROM edges; DELETE FROM contacts;');
  for (const [id, name] of [
    ['c1', 'Jane Doe'],
    ['c2', 'Pat Lee'],
  ] as const) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ id, fullName: name, source: 'test', createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

describe('/edges page', () => {
  it('shows the empty-state onboarding', async () => {
    const html = await render();
    expect(html).toContain('No edges yet');
    expect(html).toContain('add-edge');
  });

  it('renders confirmed links', async () => {
    fixture.conn.db
      .insert(fixture.conn.schema.edges)
      .values({
        id: 'e1',
        sourceId: 'c1',
        targetId: 'c2',
        relation: 'colleague',
        source: 'manual',
        status: 'confirmed',
        confidence: 1,
        strength: 0.5,
        bidirectional: true,
        discoveredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const html = await render();
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Pat Lee');
    expect(html).toContain('colleague');
    expect(html).toContain('actions-e1');
  });
});
