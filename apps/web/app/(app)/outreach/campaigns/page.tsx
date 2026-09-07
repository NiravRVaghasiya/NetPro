import Link from 'next/link';
import { conn } from '@/lib/db';
import { listCampaigns, CAMPAIGN_STATUSES, type CampaignStatus } from '@netpro/core/src/campaigns';
import { CampaignCreatePanel } from './panels';

export const metadata = {
  title: 'Campaigns — NetPro',
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const PAGE_SIZE = 25;

/**
 * /outreach/campaigns — batch outreach from the blueprint. NetPro drafts and
 * personalizes; a human sends from their own mailbox and records the result.
 * The list reads straight through the core module (same pattern as /contacts);
 * creation and lifecycle mutations go through the client panels and the
 * /api/campaigns routes.
 */
export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const statusParam = one(sp.status);
  const status = CAMPAIGN_STATUSES.includes(statusParam as CampaignStatus)
    ? (statusParam as CampaignStatus)
    : undefined;
  const rawOffset = Number(one(sp.offset) ?? '0');
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

  const page = await listCampaigns(conn, { status, limit: PAGE_SIZE, offset });

  const statusHref = (value?: CampaignStatus) =>
    `/outreach/campaigns${value ? `?status=${value}` : ''}`;

  return (
    <div>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/outreach">← Outreach</Link>
      </p>
      <h1>Campaigns</h1>
      <p style={{ marginTop: '0.25rem', color: '#475569' }}>
        Draft personalized outreach once, then send it yourself — NetPro logs every
        confirmed send as a real interaction.
      </p>

      <section aria-label="Campaign list" style={{ marginTop: '1rem' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          Filter:{' '}
          <span style={{ marginRight: '0.75rem' }}>
            {status === undefined ? <strong>All</strong> : <Link href={statusHref(undefined)}>All</Link>}
          </span>
          {CAMPAIGN_STATUSES.map((s) => (
            <span key={s} style={{ marginRight: '0.75rem' }}>
              {status === s ? <strong>{s}</strong> : <Link href={statusHref(s)}>{s}</Link>}
            </span>
          ))}
        </div>

        {page.total === 0 ? (
          <p>No campaigns yet — create your first draft below.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Sent</th>
                  <th>Replied</th>
                  <th>Recipients</th>
                </tr>
              </thead>
              <tbody>
                {page.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/outreach/campaigns/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{c.status}</td>
                    <td>{c.type === 'sequence' ? `${c.steps.length + 1}-step` : 'single'}</td>
                    <td>{c.sent}</td>
                    <td>{c.replied}</td>
                    <td>{c.totalRecipients}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem' }}>
              {offset > 0 && (
                <Link href={`/outreach/campaigns?${status ? `status=${status}&` : ''}offset=${Math.max(0, offset - PAGE_SIZE)}`}>
                  ← Previous
                </Link>
              )}
              {offset + page.campaigns.length < page.total && (
                <Link href={`/outreach/campaigns?${status ? `status=${status}&` : ''}offset=${offset + PAGE_SIZE}`}>
                  Next →
                </Link>
              )}
            </div>
          </>
        )}
      </section>

      <section aria-label="New campaign" style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>New campaign</h2>
        <CampaignCreatePanel />
      </section>
    </div>
  );
}
