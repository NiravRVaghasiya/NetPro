import { conn } from '@/lib/db';
import { analyzeNetworkGaps } from '@netpro/core/src/skills';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || '';

export default async function SkillsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const role = one(q.role);
  const description = one(q.description);
  const rows = await conn.db.select().from(conn.schema.contacts);
  const result = role || description ? analyzeNetworkGaps({ role, description }, rows.filter((r) => !r.deletedAt).map((r) => r as never)) : null;
  return <main style={{ maxWidth: 860, margin: '2rem auto', padding: '0 1rem' }}>
    <h1>Skills gap analyzer</h1>
    <p>Find the people in your network who can help with a target role. Analysis is local and uses NetPro&apos;s explainable skill taxonomy.</p>
    <form method="get" style={{ display: 'grid', gap: '.75rem', maxWidth: 620 }}>
      <label>Target role<input name="role" defaultValue={role} placeholder="Staff Engineer" style={{ display: 'block', width: '100%', padding: '.5rem' }} /></label>
      <label>Description or required skills<textarea name="description" defaultValue={description} rows={4} placeholder="TypeScript, Kubernetes, and security" style={{ display: 'block', width: '100%', padding: '.5rem' }} /></label>
      <button type="submit" style={{ width: 'fit-content', padding: '.5rem .9rem' }}>Analyze network</button>
    </form>
    {result ? <section style={{ marginTop: '2rem' }}><h2>Required skills</h2><p>{result.required.join(', ') || 'No recognized taxonomy skills. Add concrete skills to the description.'}</p><h2>Coverage</h2><table><thead><tr><th>Skill</th><th>Contacts</th></tr></thead><tbody>{result.gaps.map((gap) => <tr key={gap.skill}><td>{gap.skill}</td><td>{gap.contacts.length ? gap.contacts.map((c) => c.fullName).join(', ') : 'No matching contact'}</td></tr>)}</tbody></table></section> : null}
  </main>;
}
