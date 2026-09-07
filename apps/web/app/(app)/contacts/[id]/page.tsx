import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conn } from '@/lib/db';
import { getContactTimeline } from '@netpro/core/src/crm';
import { dueLabel, relativeDayLabel, scoreLabel, utcDay } from '@/lib/format';
import { AddFollowUpPanel, FollowUpActions, LogInteractionPanel } from './panels';

/**
 * /contacts/[id] — the individual contact from the blueprint: enriched
 * profile, interaction history, and follow-ups. The timeline is one core
 * call (`getContactTimeline`); mutations go through the client panels and
 * the CRM API routes.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const timeline = await getContactTimeline(conn, id);
  if (!timeline) notFound();

  const { contact, stats, interactions, followUps } = timeline;
  const now = new Date();
  const links = [
    contact.email ? { href: `mailto:${contact.email}`, label: contact.email } : null,
    contact.linkedinUrl ? { href: contact.linkedinUrl, label: 'LinkedIn' } : null,
    contact.githubUrl ? { href: contact.githubUrl, label: 'GitHub' } : null,
  ].filter((l): l is { href: string; label: string } => l !== null);

  return (
    <div>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/contacts">← Contacts</Link>
      </p>

      <h1>{contact.fullName}</h1>
      {contact.headline && <p style={{ margin: '0.25rem 0' }}>{contact.headline}</p>}
      <p style={{ margin: '0.25rem 0', color: '#475569' }}>
        {[contact.role, contact.company, contact.location].filter(Boolean).join(' · ') || '—'}
      </p>
      {links.length > 0 && (
        <p style={{ margin: '0.25rem 0', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {links.map((l) => (
            <Link key={l.label} href={l.href}>
              {l.label}
            </Link>
          ))}
        </p>
      )}

      <p style={{ marginTop: '0.75rem' }}>
        Score <strong>{scoreLabel(stats.relationshipScore)}</strong> ·{' '}
        {stats.interactionCount} interaction{stats.interactionCount === 1 ? '' : 's'} · last touch{' '}
        {stats.lastInteraction ? relativeDayLabel(stats.lastInteraction, now) : 'never'}
      </p>

      <section aria-label="Pending follow-ups" style={{ marginTop: '1.25rem' }}>
        <h2 style={{ fontSize: '1rem' }}>
          Follow-ups{followUps.length > 0 ? ` (${followUps.length} pending)` : ''}
        </h2>
        {followUps.length === 0 ? (
          <p style={{ margin: '0.25rem 0' }}>Nothing scheduled.</p>
        ) : (
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
            {followUps.map((f) => (
              <li key={f.id} style={{ marginBottom: '0.5rem' }}>
                Due {dueLabel(f.effectiveDueAt, now)}
                {f.reason ? ` · “${f.reason}”` : ''}
                {f.recurring && f.recurrenceRule ? ` · every ${f.recurrenceRule}` : ''}
                <div style={{ marginTop: '0.25rem' }}>
                  <FollowUpActions followUpId={f.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: '0.75rem' }}>
          <AddFollowUpPanel contactId={contact.id} />
        </div>
      </section>

      <section aria-label="Interaction history" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>
          Interaction history{interactions.length > 0 ? ` (${interactions.length})` : ''}
        </h2>
        {interactions.length === 0 ? (
          <p style={{ margin: '0.25rem 0' }}>
            No interactions yet — log the first one below. Everything you log feeds the
            relationship score and the network analytics.
          </p>
        ) : (
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
            {interactions.map((i) => (
              <li key={i.id} style={{ marginBottom: '0.35rem' }}>
                <strong>
                  {utcDay(i.occurredAt)} ({relativeDayLabel(i.occurredAt, now)})
                </strong>{' '}
                · {i.type}
                {i.direction ? (i.direction === 'outbound' ? ' → outbound' : ' ← inbound') : ''}
                {i.channel ? ` · ${i.channel}` : ''}
                {i.subject ? ` · “${i.subject}”` : ''}
                {i.content ? <div style={{ color: '#475569' }}>{i.content}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: '0.75rem' }}>
          <LogInteractionPanel contactId={contact.id} />
        </div>
      </section>

      {contact.notes && (
        <section aria-label="Notes" style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Notes</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{contact.notes}</p>
        </section>
      )}
    </div>
  );
}
