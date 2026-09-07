import { describe, expect, it } from 'vitest';
import { analyzeNetworkGaps, gapAnalysis, networkSkillCounts, parseTarget } from './gap';

describe('parseTarget', () => {
  it('reads skills out of a role, a prose description and an explicit list', () => {
    expect(parseTarget({ role: 'Staff Engineer' }).required).toEqual([]);
    expect(parseTarget({ role: 'Engineering Manager, Platform' }).required).toEqual(['engineering management']);
    const parsed = parseTarget({
      role: 'Staff Engineer',
      description: 'We need TypeScript and Kubernetes; security experience is a plus. You will go far.',
      skills: ['Go', 'k8s', 'Underwater basket weaving'],
    });
    expect(parsed.required).toEqual(['typescript', 'go', 'kubernetes', 'security']);
    expect(parsed.unrecognized).toEqual(['Underwater basket weaving']);
  });

  it('treats comma/bullet separated descriptions as value lists (so `Go` counts there)', () => {
    expect(parseTarget({ description: 'Requirements:\n- Go\n- Excel\n• Spark' }).required).toEqual(['go', 'spark', 'excel']);
    // …but not in flowing prose.
    expect(parseTarget({ description: 'You will go the extra mile and excel at your craft.' }).required).toEqual([]);
  });

  it('accepts the skills field as a delimited string and dedupes aliases', () => {
    expect(parseTarget({ skills: 'kubernetes, K8s; TypeScript' })).toEqual({ required: ['typescript', 'kubernetes'], unrecognized: [] });
    expect(parseTarget({})).toEqual({ required: [], unrecognized: [] });
  });
});

describe('gapAnalysis', () => {
  it('returns present, partial, missing and a hand-checkable score', () => {
    const r = gapAnalysis(
      { role: 'Staff Engineer', description: 'TypeScript, Kubernetes, security, full stack' },
      ['typescript', 'security', 'frontend', 'backend', 'docker'],
    );
    expect(r.required).toEqual(['typescript', 'full stack', 'kubernetes', 'security']);
    expect(r.present).toEqual(['typescript', 'security']);
    expect(r.partial).toEqual(['full stack', 'kubernetes']);
    expect(r.partialVia).toEqual({ 'full stack': ['frontend', 'backend'], kubernetes: ['docker'] });
    expect(r.missing).toEqual([]);
    // (2 + 0.5 × 2) / 4
    expect(r.matchScore).toBe(0.75);
  });

  it('scores 0 with nothing required, 1 with everything present, and rounds to 2 dp', () => {
    expect(gapAnalysis({ description: 'nothing here' }, ['rust']).matchScore).toBe(0);
    expect(gapAnalysis({ skills: ['rust'] }, ['Rust']).matchScore).toBe(1);
    expect(gapAnalysis({ skills: ['rust', 'go', 'java'] }, ['rust']).matchScore).toBe(0.33);
  });

  it('ignores candidate entries outside the taxonomy and accepts a pre-parsed target', () => {
    const parsed = parseTarget({ skills: ['python'] });
    expect(gapAnalysis(parsed, ['python', 'wizardry']).present).toEqual(['python']);
    expect(gapAnalysis(parsed, []).missing).toEqual(['python']);
  });
});

const contacts = [
  { id: 'a', fullName: 'Ada', role: 'Python engineer', relationshipScore: 0.9 },
  { id: 'b', fullName: 'Bob', notes: 'SQL and AWS', relationshipScore: 0.4 },
  { id: 'c', fullName: 'Cy', headline: 'Data engineer (Python, SQL, PySpark)', relationshipScore: 0.6 },
  { id: 'd', fullName: 'Dee', headline: 'Product designer', relationshipScore: 0.7 },
];

describe('analyzeNetworkGaps', () => {
  it('aggregates who can fill each required skill, strongest tie first', () => {
    const r = analyzeNetworkGaps({ role: 'Data Engineer', description: 'Python, SQL, AWS, Kubernetes' }, contacts);
    expect(r.required).toEqual(['python', 'sql', 'aws', 'kubernetes', 'data engineering']);
    expect(r.contactCount).toBe(4);
    const python = r.coverage.find((c) => c.skill === 'python')!;
    expect(python.count).toBe(2);
    expect(python.contacts.map((c) => c.id)).toEqual(['a', 'c']); // 0.9 before 0.6
    expect(r.coverage.find((c) => c.skill === 'sql')!.contacts.map((c) => c.id)).toEqual(['c', 'b']);
    // Sorted by count desc, then required order.
    expect(r.coverage.map((c) => c.skill)).toEqual(['python', 'sql', 'aws', 'data engineering', 'kubernetes']);
    expect(r.gaps).toEqual(['kubernetes']);
    expect(r.coveredCount).toBe(4);
  });

  it('ranks candidates by match score then relationship, dropping zero-score contacts', () => {
    const r = analyzeNetworkGaps({ skills: ['python', 'sql'] }, contacts);
    expect(r.candidates.map((c) => [c.id, c.gap.matchScore])).toEqual([
      ['c', 1],
      ['a', 0.5],
      ['b', 0.5],
    ]);
    expect(r.candidates.find((c) => c.id === 'd')).toBeUndefined();
  });

  it('counts partial coverage separately and reports a skill as a gap only when nobody covers it at all', () => {
    const r = analyzeNetworkGaps({ skills: ['cloud'] }, contacts);
    const cloud = r.coverage[0]!;
    expect(cloud.count).toBe(0);
    expect(cloud.partialCount).toBe(1); // Bob's aws ⇒ partial cloud
    expect(r.gaps).toEqual([]);
  });

  it('honours perSkill / candidates caps and handles an empty network', () => {
    const r = analyzeNetworkGaps({ skills: ['python'] }, contacts, { perSkill: 1, candidates: 1 });
    expect(r.coverage[0]!.contacts).toHaveLength(1);
    expect(r.coverage[0]!.count).toBe(2);
    expect(r.candidates).toHaveLength(1);
    const empty = analyzeNetworkGaps({ skills: ['python'] }, []);
    expect(empty).toMatchObject({ contactCount: 0, gaps: ['python'], coveredCount: 0, candidates: [] });
  });

  it('uses an injected extractor when given one', () => {
    const r = analyzeNetworkGaps({ skills: ['rust'] }, contacts, {
      extract: () => ({ skills: ['rust'], details: [], evidence: {}, mode: 'heuristic' }),
    });
    expect(r.coverage[0]!.count).toBe(4);
  });
});

describe('networkSkillCounts', () => {
  it('tallies the network skill map, most common first', () => {
    const r = networkSkillCounts(contacts);
    expect(r.contactCount).toBe(4);
    expect(r.withSkills).toBe(4);
    expect(r.counts[0]).toEqual({ skill: 'python', count: 2 });
    expect(r.counts.map((c) => c.skill)).toEqual(['python', 'sql', 'aws', 'data engineering', 'product design', 'spark']);
    expect(r.distinct).toBe(6);
  });

  it('keeps the top N by count when limited, still reporting the distinct total', () => {
    const r = networkSkillCounts(contacts, { limit: 2 });
    expect(r.counts.map((c) => c.skill)).toEqual(['python', 'sql']);
    expect(r.distinct).toBe(6);
    expect(networkSkillCounts(contacts, { limit: 0 }).counts).toHaveLength(1);
    expect(networkSkillCounts([], { limit: 5 })).toEqual({ counts: [], contactCount: 0, withSkills: 0, distinct: 0 });
  });
});
