import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conn } from '@/lib/db';
import { getContactTimeline } from '@netpro/core/src/crm';
import { getSkillsProfile, skillCategory, type Skill } from '@netpro/core/src/skills';
import { listContactEvents } from '@netpro/core/src/events';
import { listContactContent } from '@netpro/core/src/content';
import { dueLabel, relativeDayLabel, scoreLabel, utcDay } from '@/lib/format';
import { platformLabel } from '@/lib/content';
import { AddFollowUpPanel, FollowUpActions, LogInteractionPanel } from './panels';
import { MetAtEventPanel } from '../../edges/panels';

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
  // v2.0 Phase 5 — stored verdict + fresh evidence, one core call.
  const skills = await getSkillsProfile(conn, id);
  // v2.0 Phase 6 — where you crossed paths with this person.
  const events = await listContactEvents(conn, id);
  // v2.5 Phase 5 — content this person is part of (co-authored, mentioned…).
  const content = await listContactContent(conn, id);

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

      {skills ? <SkillsSection profile={skills} /> : null}

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

      <section aria-label="Events" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>
          Events{events.length > 0 ? ` (${events.length})` : ''}{' '}
          <Link href="/events" style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>
            event matcher
          </Link>
        </h2>
        {events.length === 0 ? (
          <p style={{ margin: '0.25rem 0', color: '#9ca3af' }}>
            No events recorded — record where you met below, or import an attendee list.
          </p>
        ) : (
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
            {events.map((e) => (
              <li key={e.id} style={{ marginBottom: '0.25rem' }}>
                <Link href={`/events/${encodeURIComponent(e.id)}`}>{e.name}</Link>
                {e.location ? <span style={{ color: '#6b7280' }}> · {e.location}</span> : null}
                {e.startsAt ? (
                  <span style={{ color: '#6b7280' }}>
                    {' '}
                    · {utcDay(e.startsAt)} ({relativeDayLabel(e.startsAt, now)})
                  </span>
                ) : null}
                {e.attendeeCount > 1 ? (
                  <span style={{ color: '#6b7280' }}> · {e.attendeeCount} in your network</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Content" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>
          Content{content.length > 0 ? ` (${content.length})` : ''}{' '}
          <Link href="/content" style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>
            content tracker
          </Link>
        </h2>
        {content.length === 0 ? (
          <p style={{ margin: '0.25rem 0', color: '#9ca3af' }}>
            No content links this person yet — mention them on a piece&apos;s page (co-authored,
            quoted, reviewed…).
          </p>
        ) : (
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
            {content.map((c) => (
              <li key={c.id} style={{ marginBottom: '0.25rem' }}>
                <Link href={`/content/${encodeURIComponent(c.id)}`}>{c.title}</Link>
                <span style={{ color: '#6b7280' }}>
                  {' '}
                  · {platformLabel(c.platform)}
                  {c.publishedAt ? ` · ${utcDay(c.publishedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Also met at" style={{ marginTop: '1.5rem' }}>
        <MetAtEventPanel contactId={contact.id} />
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

/**
 * Skill tags with their evidence (v2.0 Phase 5). Tags are the union of the
 * stored verdict and what the current text supports; a stored skill the text
 * no longer backs is shown, but marked, so an owner/AI claim is never
 * silently dropped and never silently trusted.
 */
function SkillsSection({ profile }: { profile: NonNullable<Awaited<ReturnType<typeof getSkillsProfile>>> }) {
  const { stored, current, unsupported, evidence } = profile;
  const tags: Skill[] = [...new Set<Skill>([...current.skills, ...stored])];
  const evidenceFor = (skill: Skill) => current.evidence[skill]?.[0];
  const latest = evidence[0];
  return (
    <section aria-label="Skills" style={{ marginTop: '1.25rem' }}>
      <h2 style={{ fontSize: '1rem' }}>
        Skills{' '}
        <Link href={`/skills`} style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>
          gap analyzer
        </Link>
      </h2>
      {tags.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>
          No taxonomy skills recognised in this contact&apos;s headline, role, notes or tags yet.
        </p>
      ) : (
        <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', padding: 0, listStyle: 'none', margin: 0 }}>
          {tags.map((skill) => {
            const ev = evidenceFor(skill);
            const stale = unsupported.includes(skill);
            const title = ev
              ? `${skillCategory(skill)} · from ${ev.field}: “${ev.snippet}”`
              : 'stored verdict — not supported by the current text';
            return (
              <li key={skill}>
                <Link
                  href={`/skills?skills=${encodeURIComponent(skill)}`}
                  title={title}
                  style={{
                    display: 'inline-block',
                    padding: '0.2rem 0.6rem',
                    border: `1px ${stale ? 'dashed' : 'solid'} ${stale ? '#d97706' : '#e5e7eb'}`,
                    borderRadius: 999,
                    textDecoration: 'none',
                    color: stale ? '#92400e' : '#1f2937',
                  }}
                >
                  {skill}
                  {stale ? ' ?' : ''}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {current.details.length > 0 ? (
        <details style={{ marginTop: '0.5rem' }}>
          <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: '0.85rem' }}>
            Why these skills? ({current.details.length} matched)
          </summary>
          <ul style={{ fontSize: '0.85rem', color: '#374151', paddingLeft: '1.25rem' }}>
            {current.details.map((d) => (
              <li key={d.skill}>
                <strong>{d.skill}</strong> [{d.category}] · {d.confidence.toFixed(2)} ·{' '}
                {d.evidence.map((e) => `${e.field}: “${e.snippet}”`).join('; ')}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
        {stored.length === 0
          ? 'Not stored yet — tags above are live from the current text; derive skills on the gap analyzer page to store them.'
          : `Stored ${latest ? `by ${latest.provider.replace('skills_', '')} extraction on ${utcDay(latest.fetchedAt)}` : ''}${
              unsupported.length > 0 ? ` · ${unsupported.join(', ')} stored but not supported by the current text` : ''
            }.`}
      </p>
    </section>
  );
}
