import { describe, expect, it } from 'vitest';
import { boundedInt, extractModeParam, skillTargetParams, MAX_TARGET_CHARS } from './skills-request';
import { CrmRequestError } from './crm-request';

const sp = (qs: string) => new URLSearchParams(qs);

describe('skillTargetParams', () => {
  it('trims and nulls the three target fields', () => {
    expect(skillTargetParams(sp('role=%20Staff%20Engineer%20&skills=python,k8s'))).toEqual({
      role: 'Staff Engineer',
      description: null,
      skills: 'python,k8s',
    });
  });

  it('rejects an empty target with a 400', () => {
    for (const qs of ['', 'role=', 'role=%20&description=%20&skills=']) {
      expect(() => skillTargetParams(sp(qs))).toThrowError(CrmRequestError);
      try {
        skillTargetParams(sp(qs));
      } catch (e) {
        expect((e as CrmRequestError).status).toBe(400);
      }
    }
  });

  it('bounds each field at the shared cap', () => {
    expect(() => skillTargetParams(sp(`description=${'x'.repeat(MAX_TARGET_CHARS + 1)}`))).toThrow(/description must be/);
    expect(skillTargetParams(sp(`role=${'x'.repeat(MAX_TARGET_CHARS)}`)).role).toHaveLength(MAX_TARGET_CHARS);
  });
});

describe('extractModeParam', () => {
  it('defaults to heuristic and accepts only the two modes', () => {
    expect(extractModeParam(undefined)).toBe('heuristic');
    expect(extractModeParam(null)).toBe('heuristic');
    expect(extractModeParam('')).toBe('heuristic');
    expect(extractModeParam('ai')).toBe('ai');
    expect(() => extractModeParam('llm')).toThrow(/Unknown mode "llm"/);
    expect(() => extractModeParam(42)).toThrow(/Unknown mode "42"/);
  });
});

describe('boundedInt', () => {
  it('clamps, truncates, and falls back on garbage', () => {
    expect(boundedInt(null, 10, 1, 100)).toBe(10);
    expect(boundedInt('', 10, 1, 100)).toBe(10);
    expect(boundedInt('abc', 10, 1, 100)).toBe(10);
    expect(boundedInt('0', 10, 1, 100)).toBe(1);
    expect(boundedInt('999', 10, 1, 100)).toBe(100);
    expect(boundedInt('7.9', 10, 1, 100)).toBe(7);
  });
});
