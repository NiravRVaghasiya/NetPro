import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));
// The composer is a client island; the page test pins what the server hands it.
vi.mock('./composer', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="composer" data-props={JSON.stringify(props ?? null)} />
  ),
}));

import OutreachPage from './page';

const NOW = new Date('2026-09-07T12:00:00Z').toISOString();

async function render(sp: Record<string, string> = {}): Promise<{ html: string; props: Record<string, unknown> }> {
  const element = await OutreachPage({ searchParams: Promise.resolve(sp) });
  const html = renderToStaticMarkup(element as unknown as React.ReactElement);
  const m = html.match(/data-props="([^"]*)"/);
  const raw = m?.[1];
  return { html, props: raw ? (JSON.parse(raw.replace(/&quot;/g, '"')) as Record<string, unknown>) : {} };
}

beforeEach(async () => {
  fixture.sqlite.exec('DELETE FROM contacts;');
  await fixture.conn.db.insert(fixture.conn.schema.contacts).values({
    id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev', company: 'Engines', role: 'Founder',
    source: 'test', createdAt: NOW, updatedAt: NOW,
  });
});
afterAll(() => fixture.sqlite.close());

describe('/outreach deep-link prefill (v2.0 Phase 3)', () => {
  it('passes nothing when no params are present', async () => {
    const { props } = await render();
    expect(props).toEqual({});
  });

  it('resolves contactId into an initial contact and forwards context/purpose', async () => {
    const { props } = await render({
      contactId: 'a',
      context: 'Warm-intro chain in NetPro: Ada → Zoe',
      purpose: 'an introduction to Zoe',
    });
    expect(props.initialContact).toMatchObject({ id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev' });
    expect(props.initialContext).toContain('Warm-intro chain');
    expect(props.initialPurpose).toBe('an introduction to Zoe');
  });

  it('ignores unknown or deleted contact ids instead of crashing', async () => {
    const { props } = await render({ contactId: 'ghost' });
    expect(props.initialContact).toBeUndefined();
    fixture.sqlite.exec("UPDATE contacts SET deleted_at = '2026-09-06T00:00:00.000Z';");
    const deleted = await render({ contactId: 'a' });
    expect(deleted.props.initialContact).toBeUndefined();
  });
});
