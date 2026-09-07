import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conn } from '@/lib/db';
import { renderCampaign, campaignSequence } from '@netpro/core/src/campaigns';
import { relativeDayLabel, utcDay } from '@/lib/format';
import { CampaignStatusActions, RecipientActions } from '../panels';

/**
 * /outreach/campaigns/[id] — one campaign: the message sequence, the daily-limit
 * meter, and every recipient with its personalized next draft and the
 * send/reply/skip actions. The render is one core call (`renderCampaign`);
 * mutations go through the client panels and the /api/campaigns routes.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const render = await renderCampaign(conn, id);
  if (!render) notFound();

  const { campaign, recipients, sequenceLength, sentToday, dailyLimitRemaining } = render;
  const sequence = campaignSequence(campaign);
  const now = new Date();

  return (
    <div>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/outreach/campaigns">← Campaigns</Link>
      </p>

      <h1>{campaign.name}</h1>
      {campaign.description && <p style={{ margin: '0.25rem 0', color: '#475569' }}>{campaign.description}</p>}
      <p style={{ margin: '0.25rem 0' }}>
        Status <strong>{campaign.status}</strong> · {campaign.type === 'sequence' ? `${sequenceLength}-message sequence` : 'single message'} ·
        daily limit {campaign.dailyLimit}
        {campaign.sendFrom ? ` · from ${campaign.sendFrom}` : ''}
      </p>
      <p style={{ margin: '0.25rem 0' }}>
        {campaign.totalRecipients} recipient{campaign.totalRecipients === 1 ? '' : 's'} ·{' '}
        <strong>{campaign.sent}</strong> sent · <strong>{campaign.replied}</strong> replied
      </p>

      <div style={{ marginTop: '0.75rem' }}>
        <CampaignStatusActions campaignId={campaign.id} status={campaign.status} />
      </div>

      {campaign.status === 'active' && (
        <p style={{ marginTop: '0.75rem', color: '#475569' }}>
          Today: <strong>{sentToday}</strong> sent ·{' '}
          <strong>{dailyLimitRemaining}</strong> remaining under the daily limit.
        </p>
      )}

      <section aria-label="Message sequence" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>Message sequence</h2>
        <ol style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
          {sequence.map((m, i) => (
            <li key={i} style={{ marginBottom: '0.5rem' }}>
              <strong>{m.subject}</strong>
              <span style={{ color: '#777', fontSize: '0.85rem' }}>
                {' '}
                · {i === 0 ? 'sent first' : `${campaign.steps[i - 1]!.delayDays} days after the previous`}
              </span>
              <div style={{ whiteSpace: 'pre-wrap', color: '#475569' }}>{m.body}</div>
            </li>
          ))}
        </ol>
        <p style={{ color: '#777', fontSize: '0.85rem', margin: '0.25rem 0' }}>
          Personalize with merge variables: {'{{firstName}}'}, {'{{lastName}}'}, {'{{fullName}}'},{' '}
          {'{{company}}'}, {'{{role}}'}, {'{{email}}'}, {'{{headline}}'}, {'{{location}}'}, {'{{industry}}'}.
        </p>
      </section>

      <section aria-label="Recipients" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>
          Recipients{recipients.length > 0 ? ` (${recipients.length})` : ''}
        </h2>
        {recipients.length === 0 ? (
          <p style={{ margin: '0.25rem 0' }}>
            No recipients yet. Add them from a search or by contact id when you create the
            campaign (draft campaigns can be extended via the API).
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Status</th>
                <th>Next draft</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/contacts/${r.contactId}`}>{r.contactName}</Link>
                    {r.company ? <span style={{ color: '#777' }}> · {r.company}</span> : null}
                  </td>
                  <td>
                    {r.status}
                    {r.contactDeleted ? <span style={{ color: '#b91c1c' }}> (contact deleted)</span> : null}
                    {r.scheduledAt ? (
                      <div style={{ color: '#777', fontSize: '0.85rem' }}>
                        next {utcDay(r.scheduledAt)} ({relativeDayLabel(r.scheduledAt, now)})
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {r.draft ? (
                      <div>
                        <strong>{r.draft.subject}</strong>
                        <div style={{ whiteSpace: 'pre-wrap', color: '#475569' }}>{r.draft.body}</div>
                      </div>
                    ) : (
                      <span style={{ color: '#777' }}>—</span>
                    )}
                  </td>
                  <td>
                    <RecipientActions campaignId={campaign.id} recipientId={r.id} status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
