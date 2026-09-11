import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  executeCampaignAddRecipients,
  executeCampaignCreate,
  executeCampaignList,
  executeCampaignMarkReplied,
  executeCampaignMarkSent,
  executeCampaignMarkSkipped,
  executeCampaignShow,
  executeCampaignStatus,
  parseStep,
  resolveCampaignId,
  resolveRecipientId,
  renderCampaignLine,
} from './campaign';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => {
  fixture.sqlite.close();
});

const conn = () => fixture.conn;

function seedContact(id: string, fullName: string, company = 'Stripe', email?: string) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: email ?? `${id}@example.com`,
      company,
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

describe('parseStep', () => {
  it('splits DAYS:SUBJECT:BODY and lets the body contain colons', () => {
    expect(parseStep('3:Still there?:Any update on {{company}}: the team?')).toEqual({
      delayDays: 3,
      subject: 'Still there?',
      body: 'Any update on {{company}}: the team?',
    });
  });

  it('rejects malformed specs and bad delays', () => {
    expect(() => parseStep('nope')).toThrowError(/DAYS:SUBJECT:BODY/);
    expect(() => parseStep('3:only-two')).toThrowError(/DAYS:SUBJECT:BODY/);
    expect(() => parseStep('0:a:b')).toThrowError(/whole number of days/);
    expect(() => parseStep('x:a:b')).toThrowError(/whole number of days/);
  });
});

describe('resolveCampaignId / resolveRecipientId', () => {
  it('resolves by name, unique prefix, and rejects ambiguity', async () => {
    const created = await executeCampaignCreate(
      { name: 'Reactivation', subject: 'Hi', body: 'There' },
      conn(),
      NOW
    );
    expect(created).toContain('Created draft campaign "Reactivation"');
    const byName = await resolveCampaignId(conn(), 'Reactivation');
    expect(byName).toBeTruthy();
    const byPrefix = await resolveCampaignId(conn(), byName.slice(0, 8));
    expect(byPrefix).toBe(byName);
    await expect(resolveCampaignId(conn(), 'nope')).rejects.toThrowError(/No campaign matches/);
  });

  it('prefers an exact campaign name over an id prefix', async () => {
    // A campaign genuinely named after a hex fragment ("cafe") and another
    // whose id starts with that same fragment: the name must win.
    const insert = (id: string, name: string) =>
      fixture.conn.db
        .insert(fixture.conn.schema.campaigns)
        .values({
          id,
          name,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .run();
    insert('cafe0000-0000-4000-8000-000000000001', 'Unrelated');
    insert('beef0000-0000-4000-8000-000000000002', 'cafe');

    expect(await resolveCampaignId(conn(), 'cafe')).toBe(
      'beef0000-0000-4000-8000-000000000002'
    );
    // Name matching stays case-insensitive, and still beats the id prefix.
    expect(await resolveCampaignId(conn(), 'CAFE')).toBe(
      'beef0000-0000-4000-8000-000000000002'
    );
  });

  it('does not read a short reference as an id prefix', async () => {
    seedContact('c1', 'Jane Doe');
    const json = await executeCampaignCreate(
      { name: 'Short', subject: 'Hi', body: 'x', contact: ['c1'], json: true },
      conn(),
      NOW
    );
    const campaignId = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    // No contact is named "zz", so a 2-character reference must not be allowed
    // to guess a recipient whose UUID happens to start with it.
    fixture.sqlite
      .prepare("UPDATE campaign_recipients SET id = 'zz' || substr(id, 3) WHERE campaign_id = ?")
      .run(campaignId);
    await expect(resolveRecipientId(conn(), campaignId, 'zz')).rejects.toThrowError(
      /No recipient matches/
    );
  });

  it('prefers a contact reference over a recipient-id prefix', async () => {
    // The regression: recipient ids are UUIDs, so a 2-character contact id is
    // also — 1-in-256 of the time — the leading fragment of another
    // recipient's id. The contact reference must win.
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const json = await executeCampaignCreate(
      { name: 'Ref', subject: 'Hi', body: 'x', dailyLimit: '1', contact: ['c1', 'c2'], json: true },
      conn(),
      NOW
    );
    const campaignId = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;

    const rows = fixture.sqlite
      .prepare('SELECT id, contact_id FROM campaign_recipients WHERE campaign_id = ?')
      .all(campaignId) as Array<{ id: string; contact_id: string }>;
    const jane = rows.find((r) => r.contact_id === 'c1')!;
    const john = rows.find((r) => r.contact_id === 'c2')!;
    // c1's recipient now starts with "c2"; c2's must resolve to itself anyway.
    fixture.sqlite
      .prepare('UPDATE campaign_recipients SET id = ? WHERE id = ?')
      .run(`c2${jane.id.slice(2)}`, jane.id);

    expect(await resolveRecipientId(conn(), campaignId, 'c2')).toBe(john.id);

    // The id-prefix ergonomic still works for a deliberate prefix.
    expect(await resolveRecipientId(conn(), campaignId, john.id.slice(0, 8))).toBe(john.id);
  });

  it('resolves a recipient by contact name, email, and id', async () => {
    seedContact('c1', 'Jane Doe', 'Stripe', 'jane@stripe.com');
    const json = await executeCampaignCreate(
      { name: 'C', subject: 'Hi {{firstName}}', body: 'x', contact: ['c1'], json: true },
      conn(),
      NOW
    );
    const campaignId = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    const byName = await resolveRecipientId(conn(), campaignId, 'Jane Doe');
    const byEmail = await resolveRecipientId(conn(), campaignId, 'jane@stripe.com');
    const byId = await resolveRecipientId(conn(), campaignId, 'c1');
    expect(byName).toBe(byEmail);
    expect(byName).toBe(byId);
    await expect(resolveRecipientId(conn(), campaignId, 'ghost')).rejects.toThrowError(
      /No recipient matches/
    );
  });
});

describe('executeCampaignCreate', () => {
  it('requires name, subject, and body', async () => {
    await expect(executeCampaignCreate({ subject: 's', body: 'b' }, conn(), NOW)).rejects.toThrowError(
      /--name is required/
    );
    await expect(executeCampaignCreate({ name: 'n', body: 'b' }, conn(), NOW)).rejects.toThrowError(
      /--subject is required/
    );
    await expect(executeCampaignCreate({ name: 'n', subject: 's' }, conn(), NOW)).rejects.toThrowError(
      /--body is required/
    );
  });

  it('builds a drip sequence from repeated --step flags', async () => {
    const json = await executeCampaignCreate(
      {
        name: 'Drip',
        subject: 'Hi {{firstName}}',
        body: 'Loved {{company}}',
        step: ['3:Bump:Still there {{firstName}}?', '7:Last:Final note'],
        json: true,
      },
      conn(),
      NOW
    );
    const result = JSON.parse(json) as { campaign: { type: string; steps: unknown[] } };
    expect(result.campaign.type).toBe('sequence');
    expect(result.campaign.steps).toHaveLength(2);
  });

  it('snapshots recipients from a search filter', async () => {
    seedContact('c1', 'Jane Doe', 'Stripe');
    seedContact('c2', 'John Smith', 'Acme');
    const json = await executeCampaignCreate(
      { name: 'Stripe', subject: 'Hi', body: 'x', company: 'Stripe', json: true },
      conn(),
      NOW
    );
    const result = JSON.parse(json) as { added: number; campaign: { totalRecipients: number } };
    expect(result.added).toBe(1);
    expect(result.campaign.totalRecipients).toBe(1);
  });

  it('reports a friendly summary without json', async () => {
    seedContact('c1', 'Jane Doe');
    const out = await executeCampaignCreate(
      { name: 'Solo', subject: 'Hi', body: 'x', contact: ['c1'] },
      conn(),
      NOW
    );
    expect(out).toContain('Created draft campaign "Solo"');
    expect(out).toContain('+1 added');
    expect(out).toContain('netpro campaign activate');
  });
});

describe('executeCampaignAddRecipients', () => {
  it('adds recipients to an existing campaign', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const json = await executeCampaignCreate(
      { name: 'C', subject: 'Hi', body: 'x', contact: ['c1'], json: true },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    const out = await executeCampaignAddRecipients(id, { contact: ['c2'] }, conn(), NOW);
    expect(out).toContain('+1 recipients added');
    const again = await executeCampaignAddRecipients(id, { contact: ['c2'] }, conn(), NOW);
    expect(again).toContain('+0 recipients added');
    expect(again).toContain('1 duplicates skipped');
  });

  it('requires a selection', async () => {
    const json = await executeCampaignCreate({ name: 'C', subject: 'Hi', body: 'x', json: true }, conn(), NOW);
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    await expect(executeCampaignAddRecipients(id, {}, conn(), NOW)).rejects.toThrowError(
      /Provide --contact/
    );
  });
});

describe('executeCampaignList', () => {
  it('lists campaigns and filters by status', async () => {
    seedContact('c1', 'Jane Doe');
    const a = await executeCampaignCreate({ name: 'A', subject: 's', body: 'b', json: true }, conn(), NOW);
    const aId = (JSON.parse(a) as { campaign: { id: string } }).campaign.id;
    await executeCampaignCreate({ name: 'B', subject: 's', body: 'b' }, conn(), NOW);
    await executeCampaignStatus(aId, 'active', {}, conn(), NOW);

    const all = await executeCampaignList({}, conn(), NOW);
    expect(all).toContain('A');
    expect(all).toContain('B');
    expect(all).toContain('2 campaigns total');

    const active = await executeCampaignList({ status: 'active' }, conn(), NOW);
    expect(active).toContain('A');
    expect(active).not.toContain('B');

    const empty = await executeCampaignList({ status: 'archived' }, conn(), NOW);
    expect(empty).toContain('No archived campaigns');
  });

  it('renders a compact status line', async () => {
    const json = await executeCampaignCreate({ name: 'Line', subject: 's', body: 'b', json: true }, conn(), NOW);
    const campaign = (JSON.parse(json) as { campaign: never }).campaign;
    expect(renderCampaignLine(campaign)).toContain('Line');
    expect(renderCampaignLine(campaign)).toContain('draft');
  });
});

describe('executeCampaignShow', () => {
  it('renders the sequence, daily meter, and per-recipient drafts', async () => {
    seedContact('c1', 'Jane Doe', 'Stripe');
    const json = await executeCampaignCreate(
      {
        name: 'Show',
        subject: 'Hi {{firstName}}',
        body: 'Loved {{company}}',
        step: ['3:Bump:Still there?'],
        contact: ['c1'],
        json: true,
      },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    const out = await executeCampaignShow(id, {}, conn(), NOW);
    expect(out).toContain('Show');
    expect(out).toContain('2 messages');
    expect(out).toContain('Hi {{firstName}}'); // the raw template subject line
    expect(out).toContain('"Hi Jane"'); // the personalized draft for Jane
    expect(out).toContain('0 sent');
  });

  it('emits JSON when asked', async () => {
    const json = await executeCampaignCreate({ name: 'J', subject: 's', body: 'b', json: true }, conn(), NOW);
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    const out = await executeCampaignShow(id, { json: true }, conn(), NOW);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('executeCampaignStatus', () => {
  it('walks the lifecycle', async () => {
    const json = await executeCampaignCreate({ name: 'S', subject: 's', body: 'b', json: true }, conn(), NOW);
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    expect(await executeCampaignStatus(id, 'active', {}, conn(), NOW)).toContain('now active');
    expect(await executeCampaignStatus(id, 'paused', {}, conn(), NOW)).toContain('now paused');
    expect(await executeCampaignStatus(id, 'active', {}, conn(), NOW)).toContain('now active');
    expect(await executeCampaignStatus(id, 'completed', {}, conn(), NOW)).toContain('now completed');
    expect(await executeCampaignStatus(id, 'archived', {}, conn(), NOW)).toContain('now archived');
  });
});

describe('mark-sent / replied / skipped end-to-end', () => {
  async function activeWithRecipient() {
    seedContact('c1', 'Jane Doe', 'Stripe', 'jane@stripe.com');
    const json = await executeCampaignCreate(
      {
        name: 'M',
        subject: 'Hi {{firstName}}',
        body: 'Loved {{company}}',
        step: ['3:Bump:Still there?'],
        contact: ['c1'],
        json: true,
      },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    await executeCampaignStatus(id, 'active', {}, conn(), NOW);
    return id;
  }

  it('mark-sent logs an interaction and schedules the next drip', async () => {
    const id = await activeWithRecipient();
    const out = await executeCampaignMarkSent(id, 'Jane Doe', {}, conn(), NOW);
    expect(out).toContain('Sent to Jane Doe');
    expect(out).toContain('logged email_sent');
    expect(out).toContain('Next message scheduled for');

    const interaction = fixture.sqlite
      .prepare("SELECT type, subject FROM interactions WHERE contact_id = 'c1'")
      .get() as { type: string; subject: string };
    expect(interaction).toMatchObject({ type: 'email_sent', subject: 'Hi Jane' });

    // second send completes the sequence
    const second = await executeCampaignMarkSent(id, 'Jane Doe', {}, conn(), new Date(NOW.getTime() + 3 * DAY));
    expect(second).toContain('Sequence complete');
  });

  it('mark-sent requires an active campaign', async () => {
    seedContact('c1', 'Jane Doe');
    const json = await executeCampaignCreate(
      { name: 'D', subject: 'Hi', body: 'x', contact: ['c1'], json: true },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    await expect(executeCampaignMarkSent(id, 'c1', {}, conn(), NOW)).rejects.toThrowError(/draft/);
  });

  it('mark-replied records the reply and cancels the drip', async () => {
    const id = await activeWithRecipient();
    await executeCampaignMarkSent(id, 'c1', {}, conn(), NOW);
    const out = await executeCampaignMarkReplied(id, 'c1', {}, conn(), new Date(NOW.getTime() + DAY));
    expect(out).toContain('Reply from Jane Doe');
    expect(out).toContain('drip cancelled');
    const inbound = fixture.sqlite
      .prepare("SELECT type, direction FROM interactions WHERE type = 'email_received'")
      .get() as { type: string; direction: string };
    expect(inbound).toMatchObject({ type: 'email_received', direction: 'inbound' });
  });

  it('mark-skipped opts out without logging an interaction', async () => {
    seedContact('c1', 'Jane Doe');
    const json = await executeCampaignCreate(
      { name: 'K', subject: 'Hi', body: 'x', contact: ['c1'], json: true },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    await executeCampaignStatus(id, 'active', {}, conn(), NOW);
    const out = await executeCampaignMarkSkipped(id, 'c1', {}, conn(), NOW);
    expect(out).toContain('Skipped Jane Doe');
    const n = fixture.sqlite.prepare('SELECT count(*) AS n FROM interactions').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('enforces the daily limit unless --force', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const json = await executeCampaignCreate(
      { name: 'L', subject: 'Hi', body: 'x', dailyLimit: '1', contact: ['c1', 'c2'], json: true },
      conn(),
      NOW
    );
    const id = (JSON.parse(json) as { campaign: { id: string } }).campaign.id;
    await executeCampaignStatus(id, 'active', {}, conn(), NOW);
    await executeCampaignMarkSent(id, 'c1', {}, conn(), NOW);
    await expect(executeCampaignMarkSent(id, 'c2', {}, conn(), NOW)).rejects.toThrowError(/daily limit/i);
    const forced = await executeCampaignMarkSent(id, 'c2', { force: true }, conn(), NOW);
    expect(forced).toContain('Sent to John Smith');
  });
});
