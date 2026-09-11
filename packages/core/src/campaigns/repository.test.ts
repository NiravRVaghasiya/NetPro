import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  addRecipients,
  createCampaign,
  getCampaign,
  listCampaigns,
  refreshCampaignStats,
  setCampaignStatus,
  updateCampaignDraft,
} from './repository';
import {
  findRecipientByContact,
  markRecipientReplied,
  markRecipientSent,
  markRecipientSkipped,
  renderCampaign,
} from './render';
import { CAMPAIGN_LIMITS } from './types';

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

function seedContact(id: string, fullName: string, extra: Record<string, unknown> = {}) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: `${id}@example.com`,
      company: 'Stripe',
      role: 'Engineer',
      source: 'test',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...extra,
    })
    .run();
}

const template = { subject: 'Hi {{firstName}}', body: 'Loved your work at {{company}}.' };

async function makeActiveCampaign(recipientIds: string[] = ['c1', 'c2']) {
  seedContact('c1', 'Jane Doe');
  seedContact('c2', 'John Smith');
  const { campaign } = await createCampaign(
    conn(),
    { name: 'Reactivation', template, recipients: { contactIds: recipientIds } },
    { now: NOW }
  );
  await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
  return campaign.id;
}

describe('createCampaign', () => {
  it('creates a draft, snapshots recipients, and reports counts', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const result = await createCampaign(
      conn(),
      { name: 'Reactivation', template, recipients: { contactIds: ['c1', 'c2'] } },
      { now: NOW }
    );
    expect(result.campaign.status).toBe('draft');
    expect(result.campaign.type).toBe('single');
    expect(result.campaign.dailyLimit).toBe(50);
    expect(result.campaign.template).toEqual(template);
    expect(result.added).toBe(2);
    expect(result.campaign.totalRecipients).toBe(2);

    // template/steps round-trip through the JSON column
    const fetched = await getCampaign(conn(), result.campaign.id);
    expect(fetched?.template).toEqual(template);
    expect(fetched?.steps).toEqual([]);
  });

  it('marks a sequence campaign when steps are present', async () => {
    const result = await createCampaign(
      conn(),
      {
        name: 'Drip',
        template,
        steps: [{ delayDays: 3, subject: 'Bump', body: 'Still interested, {{firstName}}?' }],
      },
      { now: NOW }
    );
    expect(result.campaign.type).toBe('sequence');
    expect(result.campaign.steps).toHaveLength(1);
  });

  it('validates name, template, and recipients', async () => {
    await expect(createCampaign(conn(), { name: '', template }, { now: NOW })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      createCampaign(conn(), { name: 'X', template: { subject: '{{nope}}', body: 'y' } }, { now: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      createCampaign(
        conn(),
        { name: 'X', template, recipients: { contactIds: ['ghost'] } },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('snapshots a search selection to concrete ids and dedupes', async () => {
    seedContact('c1', 'Jane Doe', { company: 'Stripe' });
    seedContact('c2', 'John Smith', { company: 'Acme' });
    const result = await createCampaign(
      conn(),
      {
        name: 'Stripe folks',
        template,
        recipients: { search: { company: 'Stripe' } },
      },
      { now: NOW }
    );
    expect(result.added).toBe(1);
    // adding the same search again is a no-op (snapshot, not live query)
    const again = await addRecipients(conn(), result.campaign.id, { search: { company: 'Stripe' } }, { now: NOW });
    expect(again.added).toBe(0);
    expect(again.skippedDuplicates).toBe(1);
  });
});

describe('addRecipients caps and dedupe', () => {
  it('skips duplicates already on the campaign', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(
      conn(),
      { name: 'X', template, recipients: { contactIds: ['c1'] } },
      { now: NOW }
    );
    const result = await addRecipients(conn(), campaign.id, { contactIds: ['c1'] }, { now: NOW });
    expect(result.added).toBe(0);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('rejects soft-deleted contacts', async () => {
    seedContact('gone', 'Deleted Person', { deletedAt: NOW.toISOString() });
    const { campaign } = await createCampaign(conn(), { name: 'X', template }, { now: NOW });
    await expect(
      addRecipients(conn(), campaign.id, { contactIds: ['gone'] }, { now: NOW })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('updateCampaignDraft', () => {
  it('edits while draft and freezes once active', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(conn(), { name: 'X', template }, { now: NOW });
    const updated = await updateCampaignDraft(
      conn(),
      campaign.id,
      { name: 'Renamed', dailyLimit: 10, template: { subject: 'Hello {{firstName}}', body: 'b' } },
      { now: NOW }
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.dailyLimit).toBe(10);
    expect(updated.template.subject).toBe('Hello {{firstName}}');

    await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
    await expect(
      updateCampaignDraft(conn(), campaign.id, { name: 'Nope' }, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('revalidates patched templates', async () => {
    const { campaign } = await createCampaign(conn(), { name: 'X', template }, { now: NOW });
    await expect(
      updateCampaignDraft(conn(), campaign.id, { template: { subject: '{{bad}}', body: 'y' } }, { now: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('setCampaignStatus lifecycle', () => {
  it('follows the transition matrix and rejects illegal moves', async () => {
    const { campaign } = await createCampaign(conn(), { name: 'X', template }, { now: NOW });
    expect((await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW })).status).toBe('active');
    expect((await setCampaignStatus(conn(), campaign.id, 'paused', { now: NOW })).status).toBe('paused');
    expect((await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW })).status).toBe('active');
    expect((await setCampaignStatus(conn(), campaign.id, 'completed', { now: NOW })).status).toBe('completed');
    expect((await setCampaignStatus(conn(), campaign.id, 'archived', { now: NOW })).status).toBe('archived');

    // archived is final
    await expect(setCampaignStatus(conn(), campaign.id, 'active', { now: NOW })).rejects.toMatchObject({
      code: 'conflict',
    });
    // draft cannot jump straight to completed
    const draft = await createCampaign(conn(), { name: 'Y', template }, { now: NOW });
    await expect(
      setCampaignStatus(conn(), draft.campaign.id, 'completed', { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
    // unknown status is a validation error, not a transition conflict
    await expect(setCampaignStatus(conn(), draft.campaign.id, 'launched', { now: NOW })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('listCampaigns', () => {
  it('lists with total, filters by status, and paginates', async () => {
    await createCampaign(conn(), { name: 'A', template }, { now: NOW });
    const b = await createCampaign(conn(), { name: 'B', template }, { now: NOW });
    await setCampaignStatus(conn(), b.campaign.id, 'active', { now: NOW });

    const all = await listCampaigns(conn());
    expect(all.total).toBe(2);
    const active = await listCampaigns(conn(), { status: 'active' });
    expect(active.campaigns.map((c) => c.name)).toEqual(['B']);
    const paged = await listCampaigns(conn(), { limit: 1, offset: 1 });
    expect(paged.campaigns).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});

describe('renderCampaign', () => {
  it('renders personalized drafts per recipient with the daily-limit meter', async () => {
    const campaignId = await makeActiveCampaign();
    const render = await renderCampaign(conn(), campaignId, { now: NOW });
    expect(render).not.toBeNull();
    expect(render!.recipients).toHaveLength(2);
    expect(render!.sequenceLength).toBe(1);
    expect(render!.sentToday).toBe(0);
    expect(render!.dailyLimitRemaining).toBe(50);

    const jane = render!.recipients.find((r) => r.contactName === 'Jane Doe')!;
    expect(jane.draft).toEqual({
      subject: 'Hi Jane',
      body: 'Loved your work at Stripe.',
    });
    expect(jane.status).toBe('pending');
  });

  it('returns null for unknown campaigns', async () => {
    expect(await renderCampaign(conn(), 'nope', { now: NOW })).toBeNull();
  });
});

describe('markRecipientSent', () => {
  it('logs an email_sent interaction, recomputes contact score, and advances stats', async () => {
    const campaignId = await makeActiveCampaign();
    const recipientId = (await findRecipientByContact(conn(), campaignId, 'c1'))!.recipientId;

    const result = await markRecipientSent(conn(), campaignId, recipientId, { now: NOW });
    expect(result.recipient.status).toBe('sent'); // single-step sequence finishes
    expect(result.campaign.sent).toBe(1);

    // the send is a real CRM interaction feeding the contact's score
    const contact = fixture.sqlite
      .prepare('SELECT interaction_count AS n, relationship_score AS s FROM contacts WHERE id = ?')
      .get('c1') as { n: number; s: number };
    expect(contact.n).toBe(1);
    expect(contact.s).toBeGreaterThan(0);

    const interaction = fixture.sqlite
      .prepare('SELECT type, direction, channel, campaign_id AS cid, subject FROM interactions')
      .get() as { type: string; direction: string; channel: string; cid: string; subject: string };
    expect(interaction).toMatchObject({
      type: 'email_sent',
      direction: 'outbound',
      channel: 'email',
      cid: campaignId,
      subject: 'Hi Jane',
    });
  });

  it('requires an active campaign', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(
      conn(),
      { name: 'X', template, recipients: { contactIds: ['c1'] } },
      { now: NOW }
    );
    const recipientId = (await findRecipientByContact(conn(), campaign.id, 'c1'))!.recipientId;
    await expect(
      markRecipientSent(conn(), campaign.id, recipientId, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('enforces the daily limit and honors force', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const { campaign } = await createCampaign(
      conn(),
      { name: 'X', template, dailyLimit: 1, recipients: { contactIds: ['c1', 'c2'] } },
      { now: NOW }
    );
    await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
    const r1 = (await findRecipientByContact(conn(), campaign.id, 'c1'))!.recipientId;
    const r2 = (await findRecipientByContact(conn(), campaign.id, 'c2'))!.recipientId;

    await markRecipientSent(conn(), campaign.id, r1, { now: NOW });
    await expect(markRecipientSent(conn(), campaign.id, r2, { now: NOW })).rejects.toMatchObject({
      code: 'conflict',
    });
    // force overrides
    const forced = await markRecipientSent(conn(), campaign.id, r2, { now: NOW, force: true });
    expect(forced.campaign.sent).toBe(2);
  });

  it('schedules the next drip step for a sequence and blocks a re-send', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(
      conn(),
      {
        name: 'Drip',
        template,
        steps: [{ delayDays: 3, subject: 'Bump', body: 'Still there, {{firstName}}?' }],
        recipients: { contactIds: ['c1'] },
      },
      { now: NOW }
    );
    await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
    const recipientId = (await findRecipientByContact(conn(), campaign.id, 'c1'))!.recipientId;

    const first = await markRecipientSent(conn(), campaign.id, recipientId, { now: NOW });
    expect(first.recipient.status).toBe('scheduled'); // more steps remain
    expect(first.recipient.scheduledAt).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(first.recipient.draft).toEqual({ subject: 'Bump', body: 'Still there, Jane?' });

    // sending the next step finishes the sequence
    const second = await markRecipientSent(
      conn(),
      campaign.id,
      recipientId,
      { now: new Date(NOW.getTime() + 3 * DAY) }
    );
    expect(second.recipient.status).toBe('sent');
    expect(second.recipient.draft).toBeNull();

    // a third send is a conflict — the sequence is complete
    await expect(
      markRecipientSent(conn(), campaign.id, recipientId, { now: new Date(NOW.getTime() + 4 * DAY) })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('blocks sending to a soft-deleted contact', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(
      conn(),
      { name: 'X', template, recipients: { contactIds: ['c1'] } },
      { now: NOW }
    );
    await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
    fixture.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), 'c1');
    const recipientId = (await findRecipientByContact(conn(), campaign.id, 'c1'))!.recipientId;
    await expect(
      markRecipientSent(conn(), campaign.id, recipientId, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('markRecipientReplied', () => {
  it('logs an inbound interaction and cancels the remaining drip', async () => {
    seedContact('c1', 'Jane Doe');
    const { campaign } = await createCampaign(
      conn(),
      {
        name: 'Drip',
        template,
        steps: [{ delayDays: 3, subject: 'Bump', body: 'Still there?' }],
        recipients: { contactIds: ['c1'] },
      },
      { now: NOW }
    );
    await setCampaignStatus(conn(), campaign.id, 'active', { now: NOW });
    const recipientId = (await findRecipientByContact(conn(), campaign.id, 'c1'))!.recipientId;
    await markRecipientSent(conn(), campaign.id, recipientId, { now: NOW });

    const replied = await markRecipientReplied(conn(), campaign.id, recipientId, {
      now: new Date(NOW.getTime() + DAY),
    });
    expect(replied.recipient.status).toBe('replied');
    expect(replied.recipient.scheduledAt).toBeNull(); // drip cancelled
    expect(replied.recipient.draft).toBeNull();
    expect(replied.campaign.replied).toBe(1);

    const inbound = fixture.sqlite
      .prepare("SELECT type, direction, subject FROM interactions WHERE type = 'email_received'")
      .get() as { type: string; direction: string; subject: string };
    expect(inbound).toMatchObject({ type: 'email_received', direction: 'inbound', subject: 'Re: Hi Jane' });

    // replying twice is a conflict
    await expect(
      markRecipientReplied(conn(), campaign.id, recipientId, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cannot record a reply before any send', async () => {
    const campaignId = await makeActiveCampaign(['c1']);
    const recipientId = (await findRecipientByContact(conn(), campaignId, 'c1'))!.recipientId;
    await expect(
      markRecipientReplied(conn(), campaignId, recipientId, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('markRecipientSkipped', () => {
  it('opts a pending recipient out without logging an interaction', async () => {
    const campaignId = await makeActiveCampaign(['c1']);
    const recipientId = (await findRecipientByContact(conn(), campaignId, 'c1'))!.recipientId;
    const skipped = await markRecipientSkipped(conn(), campaignId, recipientId, { now: NOW });
    expect(skipped.recipient.status).toBe('skipped');
    expect(skipped.recipient.draft).toBeNull();
    expect(skipped.interactionId).toBeNull();
    const n = fixture.sqlite.prepare('SELECT count(*) AS n FROM interactions').get() as { n: number };
    expect(n.n).toBe(0); // nothing sent, nothing logged
  });

  it('cannot skip after a send', async () => {
    const campaignId = await makeActiveCampaign(['c1']);
    const recipientId = (await findRecipientByContact(conn(), campaignId, 'c1'))!.recipientId;
    await markRecipientSent(conn(), campaignId, recipientId, { now: NOW });
    await expect(
      markRecipientSkipped(conn(), campaignId, recipientId, { now: NOW })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('refreshCampaignStats', () => {
  it('is self-healing: counters always match the recipient rows', async () => {
    const campaignId = await makeActiveCampaign(['c1', 'c2']);
    const recipientId = (await findRecipientByContact(conn(), campaignId, 'c1'))!.recipientId;
    await markRecipientSent(conn(), campaignId, recipientId, { now: NOW });

    // corrupt the denormalized counters, then refresh
    fixture.sqlite.prepare('UPDATE campaigns SET sent = 99, total_recipients = 0').run();
    const stats = await refreshCampaignStats(conn(), campaignId, NOW);
    expect(stats).toEqual({ totalRecipients: 2, sent: 1, replied: 0 });
  });
});

describe('recipient cap', () => {
  it('rejects exceeding the per-campaign recipient limit', async () => {
    seedContact('c1', 'Jane Doe');
    seedContact('c2', 'John Smith');
    const { campaign } = await createCampaign(conn(), { name: 'X', template }, { now: NOW });

    // Fill to the cap with real recipient rows (bulk insert; the guard counts
    // rows, not the denormalized counter).
    const insert = fixture.sqlite.prepare(
      "INSERT INTO campaign_recipients (id, campaign_id, contact_id, status, current_step) VALUES (?, ?, 'c1', 'pending', 0)"
    );
    const fill = fixture.sqlite.transaction(() => {
      for (let i = 0; i < CAMPAIGN_LIMITS.recipients; i++) {
        insert.run(`r-${i}`, campaign.id);
      }
    });
    fill();

    await expect(
      addRecipients(conn(), campaign.id, { contactIds: ['c2'] }, { now: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
