import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import('@netpro/db/src/testing');
  return createTestSqliteConn();
});
vi.mock('@/lib/db', () => ({ conn: fixture.conn }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
// The mutation panels are client components (useRouter); stub them so the
// server render stays static — their behavior is covered by the API tests.
vi.mock('./panels', () => ({
  LogInteractionPanel: () => <div data-testid="log-panel" />,
  AddFollowUpPanel: () => <div data-testid="followup-panel" />,
  FollowUpActions: ({ followUpId }: { followUpId: string }) => (
    <span data-testid={`actions-${followUpId}`} />
  ),
}));

import ContactDetailPage from './page';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

async function render(id: string): Promise<string> {
  const element = await ContactDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM follow_ups; DELETE FROM interactions; DELETE FROM contacts;'
  );
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: 'c1',
      fullName: 'Jane Doe',
      headline: 'Building payments at Stripe',
      company: 'Stripe',
      role: 'Engineer',
      location: 'Berlin',
      email: 'jane@stripe.com',
      linkedinUrl: 'https://linkedin.com/in/jane',
      notes: 'Met at React Conf.',
      source: 'test',
      relationshipScore: 0.62,
      interactionCount: 1,
      lastInteraction: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.interactions)
    .values({
      id: 'i1',
      contactId: 'c1',
      type: 'meeting',
      direction: 'outbound',
      channel: 'in_person',
      content: 'Coffee + collab talk',
      occurredAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    })
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.followUps)
    .values({
      id: 'f1',
      contactId: 'c1',
      reason: 'Send the deck',
      dueAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
      status: 'pending',
      recurring: true,
      recurrenceRule: '30d',
      createdAt: NOW.toISOString(),
    })
    .run();
});
afterAll(() => fixture.sqlite.close());

describe('/contacts/[id] detail page', () => {
  it('renders profile, stats, timeline, and follow-ups', async () => {
    // The page reads "now" at render time; seed dates are relative to a fixed
    // clock, so assert on stable content rather than relative labels.
    const html = await render('c1');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Building payments at Stripe');
    expect(html).toContain('Engineer · Stripe · Berlin');
    expect(html).toContain('jane@stripe.com');
    expect(html).toContain('linkedin.com/in/jane');
    expect(html).toContain('0.62');
    expect(html).toContain('1 interaction');
    expect(html).toContain('meeting');
    expect(html).toContain('Coffee + collab talk');
    expect(html).toContain('Send the deck');
    expect(html).toContain('every 30d');
    expect(html).toContain('Met at React Conf.');
    expect(html).toContain('log-panel');
    expect(html).toContain('followup-panel');
    expect(html).toContain('actions-f1');
  });

  it('404s for unknown contacts', async () => {
    await expect(render('missing')).rejects.toThrow('NOT_FOUND');
  });

  it('shows guidance when there is no history yet', async () => {
    fixture.sqlite.exec('DELETE FROM follow_ups; DELETE FROM interactions;');
    const html = await render('c1');
    expect(html).toContain('Nothing scheduled.');
    expect(html).toContain('No interactions yet');
  });
});
