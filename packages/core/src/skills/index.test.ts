import { describe, expect, it } from 'vitest';
import { analyzeNetworkGaps, extractSkills, gapAnalysis } from './index';

describe('skills extraction', () => {
  it('extracts bounded skills from role, notes and tags', () => {
    const result = extractSkills({ id: '1', fullName: 'Ada', role: 'Staff TypeScript Engineer', notes: 'AWS, Docker and React', tags: ['mentor'] });
    expect(result.skills).toEqual(expect.arrayContaining(['typescript', 'aws', 'docker', 'react']));
    expect(result.skills).not.toContain('staff');
  });
  it('does not treat substrings as skills', () => {
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'A javascripted process' }).skills).not.toContain('javascript');
  });
});

describe('gap analysis', () => {
  it('returns present, partial, missing and a deterministic score', () => {
    const result = gapAnalysis({ role: 'Staff Engineer', description: 'TypeScript, Kubernetes, security' }, ['typescript', 'security']);
    expect(result.present).toEqual(['typescript', 'security']);
    expect(result.missing).toEqual(['kubernetes']);
    expect(result.matchScore).toBeCloseTo(2 / 3);
  });
  it('aggregates who can fill each required skill', () => {
    const result = analyzeNetworkGaps({ role: 'Data Engineer', description: 'Python, SQL, AWS' }, [
      { id: 'a', fullName: 'A', role: 'Python engineer' },
      { id: 'b', fullName: 'B', notes: 'SQL and AWS' },
    ]);
    expect(result.gaps.find((g) => g.skill === 'python')?.contacts).toEqual([{ id: 'a', fullName: 'A' }]);
    expect(result.gaps.find((g) => g.skill === 'sql')?.count).toBe(1);
  });
});
