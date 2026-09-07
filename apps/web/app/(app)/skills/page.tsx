// apps/web/app/(app)/skills/page.tsx
//
// v2.0 Phase 5 — the skills gap analyzer. Server-rendered, GET-form driven
// (the house pattern):
//   * no target → the network skill map (what your contacts collectively
//     know) plus the extraction panel;
//   * role / description / skills → the required taxonomy skills, who covers
//     each, the skills nobody covers, and the best individual matches — each
//     linking to the contact and to a warm-intro path.
// Every number here comes from the same core functions the CLI uses, and the
// analysis is offline: the bounded taxonomy, no model call.
import Link from 'next/link';
import { conn } from '@/lib/db';
import {
  analyzeNetworkGaps,
  loadSkillContacts,
  networkSkillCounts,
  skillCategory,
  skillsStatus,
  type NetworkGapAnalysis,
} from '@netpro/core/src/skills';
import { skillTargetParams } from '@/lib/skills-request';
import { CrmRequestError } from '@/lib/crm-request';
import { scoreLabel } from '@/lib/format';
import { ExtractPanel } from './panels';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function Coverage({ analysis }: { analysis: NetworkGapAnalysis }) {
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2>
        Coverage — {analysis.coveredCount}/{analysis.required.length} skills covered by{' '}
        {analysis.contactCount} contact{analysis.contactCount === 1 ? '' : 's'}
      </h2>
      {analysis.gaps.length > 0 ? (
        <p style={{ color: '#b45309' }}>
          Nobody in your network covers: <strong>{analysis.gaps.join(', ')}</strong>.
        </p>
      ) : (
        <p style={{ color: '#15803d' }}>Every required skill is covered by at least one contact.</p>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ padding: '0.4rem 0.5rem' }}>Skill</th>
            <th style={{ padding: '0.4rem 0.5rem' }}>Category</th>
            <th style={{ padding: '0.4rem 0.5rem' }}>Has it</th>
            <th style={{ padding: '0.4rem 0.5rem' }}>Who</th>
          </tr>
        </thead>
        <tbody>
          {analysis.coverage.map((c) => (
            <tr key={c.skill} style={{ borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
              <td style={{ padding: '0.4rem 0.5rem' }}>
                <strong>{c.skill}</strong>
              </td>
              <td style={{ padding: '0.4rem 0.5rem', color: '#6b7280' }}>{skillCategory(c.skill)}</td>
              <td style={{ padding: '0.4rem 0.5rem' }}>
                {c.count}
                {c.partialCount > 0 ? <span style={{ color: '#6b7280' }}> (+{c.partialCount} partial)</span> : null}
              </td>
              <td style={{ padding: '0.4rem 0.5rem' }}>
                {c.contacts.length === 0 ? (
                  <span style={{ color: '#9ca3af' }}>—</span>
                ) : (
                  c.contacts.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 ? ', ' : ''}
                      <Link href={`/contacts/${encodeURIComponent(p.id)}`}>{p.fullName}</Link>
                      <span style={{ color: '#6b7280', fontSize: '0.8rem' }}> ({scoreLabel(p.relationshipScore)})</span>
                    </span>
                  ))
                )}
                {c.count > c.contacts.length ? (
                  <span style={{ color: '#6b7280' }}> +{c.count - c.contacts.length} more</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Candidates({ analysis }: { analysis: NetworkGapAnalysis }) {
  if (analysis.candidates.length === 0) {
    return (
      <p style={{ color: '#9ca3af', marginTop: '1.5rem' }}>
        No contact matches any of the required skills yet. Derive skills below, or add notes and tags to the
        people who have them.
      </p>
    );
  }
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2>Best matches</h2>
      <ol style={{ paddingLeft: '1.25rem' }}>
        {analysis.candidates.map((c) => (
          <li key={c.id} style={{ marginBottom: '0.5rem' }}>
            <Link href={`/contacts/${encodeURIComponent(c.id)}`}>{c.fullName}</Link>
            {c.company ? <span style={{ color: '#6b7280' }}> · {c.company}</span> : null}
            {c.role ? <span style={{ color: '#6b7280' }}> · {c.role}</span> : null} — <strong>{pct(c.gap.matchScore)}</strong>{' '}
            match · tie {scoreLabel(c.relationshipScore)}
            <div style={{ fontSize: '0.85rem', color: '#374151' }}>
              {c.gap.present.length > 0 ? <span>has {c.gap.present.join(', ')}</span> : null}
              {c.gap.partial.length > 0 ? (
                <span>
                  {c.gap.present.length > 0 ? ' · ' : ''}
                  partial {c.gap.partial.map((s) => `${s} (via ${c.gap.partialVia[s]?.join(', ') ?? '?'})`).join('; ')}
                </span>
              ) : null}
              {c.gap.missing.length > 0 ? (
                <span style={{ color: '#6b7280' }}>
                  {c.gap.present.length + c.gap.partial.length > 0 ? ' · ' : ''}missing {c.gap.missing.join(', ')}
                </span>
              ) : null}
              {' · '}
              <Link href={`/graph?target=${encodeURIComponent(c.id)}`}>Find a warm intro</Link>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function SkillsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const role = one(q.role);
  const description = one(q.description);
  const skills = one(q.skills);
  const hasTarget = Boolean(role || description || skills);

  const sp = new URLSearchParams();
  if (role) sp.set('role', role);
  if (description) sp.set('description', description);
  if (skills) sp.set('skills', skills);

  const [status, contacts] = await Promise.all([skillsStatus(conn), loadSkillContacts(conn)]);

  let analysis: NetworkGapAnalysis | null = null;
  let targetError: string | null = null;
  if (hasTarget) {
    try {
      analysis = analyzeNetworkGaps(skillTargetParams(sp), contacts);
    } catch (e) {
      // Hand-typed URLs must not 500 the page.
      if (e instanceof CrmRequestError) targetError = e.message;
      else throw e;
    }
  }
  const map = hasTarget ? null : networkSkillCounts(contacts, { limit: 40 });

  return (
    <div>
      <h1>Skills gap</h1>
      <p style={{ color: '#475569' }}>
        Describe a role and NetPro shows which required skills your network covers, who has them, and where
        the gaps are. Skills are derived from headlines, notes and tags against a fixed, explainable taxonomy
        — nothing is guessed. <Link href="/graph">Warm intros</Link> · <Link href="/search">Search</Link>
      </p>

      <form
        method="get"
        action="/skills"
        style={{ display: 'grid', gap: '0.5rem', maxWidth: 720, margin: '1rem 0' }}
      >
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Target role</span>
          <input name="role" defaultValue={role ?? ''} placeholder="Staff Data Engineer" style={{ padding: '0.4rem' }} />
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Job description or requirements (optional)</span>
          <textarea
            name="description"
            defaultValue={description ?? ''}
            rows={4}
            placeholder={'Own our data platform: Python, dbt and Airflow on AWS.\nComfortable with Kubernetes.'}
            style={{ padding: '0.4rem', fontFamily: 'inherit' }}
          />
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Explicit skills (comma-separated, optional)</span>
          <input name="skills" defaultValue={skills ?? ''} placeholder="python, k8s, aws" style={{ padding: '0.4rem' }} />
        </label>
        <div>
          <button type="submit">Analyse network</button>
        </div>
      </form>

      {targetError ? (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {targetError}
        </p>
      ) : null}

      {analysis ? (
        analysis.required.length === 0 ? (
          <p role="alert" style={{ color: '#b45309' }}>
            No taxonomy skills recognised in that target
            {analysis.target.unrecognized.length > 0
              ? ` (not in the taxonomy: ${analysis.target.unrecognized.join(', ')})`
              : ''}
            . Try concrete skill names in the explicit skills box.
          </p>
        ) : (
          <>
            <p>
              Target needs <strong>{analysis.required.length}</strong> skill
              {analysis.required.length === 1 ? '' : 's'}: {analysis.required.join(', ')}
              {analysis.target.unrecognized.length > 0 ? (
                <span style={{ color: '#6b7280' }}>
                  {' '}
                  (ignored, not in the taxonomy: {analysis.target.unrecognized.join(', ')})
                </span>
              ) : null}
            </p>
            <Coverage analysis={analysis} />
            <Candidates analysis={analysis} />
          </>
        )
      ) : null}

      <ExtractPanel neverExtracted={status.neverExtracted} total={status.contacts} />

      {map ? (
        <section style={{ marginTop: '1.5rem' }}>
          <h2>What your network knows</h2>
          {map.counts.length === 0 ? (
            <p style={{ color: '#9ca3af' }}>
              No skills recognised yet — {map.contactCount === 0 ? 'import some contacts' : 'derive skills above'} to
              build the map.
            </p>
          ) : (
            <>
              <p style={{ color: '#6b7280' }}>
                {map.withSkills} of {map.contactCount} contacts have at least one recognised skill. Top skills:
              </p>
              <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', padding: 0, listStyle: 'none' }}>
                {map.counts.map((c) => (
                  <li key={c.skill}>
                    <Link
                      href={`/skills?skills=${encodeURIComponent(c.skill)}`}
                      style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.6rem',
                        border: '1px solid #e5e7eb',
                        borderRadius: 999,
                        textDecoration: 'none',
                        color: '#1f2937',
                      }}
                      title={skillCategory(c.skill)}
                    >
                      {c.skill} <span style={{ color: '#6b7280' }}>{c.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
