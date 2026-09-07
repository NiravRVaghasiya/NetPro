import { describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '../ai/types';
import { AiProviderError } from '../ai/types';
import {
  AI_MAX_SKILLS,
  AI_SKILL_CONFIDENCE,
  buildSkillExtractionMessages,
  extractSkills,
  extractSkillsWithAi,
  listValues,
  parseSkillReply,
  storedSkills,
} from './extract';
import {
  PARTIAL_COVERAGE,
  SKILL_DEFINITIONS,
  SKILL_TAXONOMY,
  aliasTable,
  canonicalSkill,
  isSkill,
  normalizeMatchText,
  skillCategory,
} from './taxonomy';

describe('taxonomy integrity', () => {
  it('has unique names and no alias that maps to two skills', () => {
    const names = SKILL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    const owners = new Map<string, string>();
    for (const def of SKILL_DEFINITIONS) {
      for (const key of [def.name, ...def.aliases].map(normalizeMatchText)) {
        const owner = owners.get(key);
        expect(owner === undefined || owner === def.name, `"${key}" claimed by ${owner} and ${def.name}`).toBe(true);
        owners.set(key, def.name);
      }
    }
  });

  it('keeps every partial-coverage rule inside the taxonomy', () => {
    for (const [skill, rule] of Object.entries(PARTIAL_COVERAGE)) {
      expect(isSkill(skill)).toBe(true);
      for (const s of [...(rule.all ?? []), ...(rule.any ?? [])]) expect(isSkill(s)).toBe(true);
    }
  });

  it('canonicalises aliases, case and whitespace; rejects unknowns', () => {
    expect(canonicalSkill('K8s')).toBe('kubernetes');
    expect(canonicalSkill('  Type Script ')).toBeNull(); // not an alias — no fuzzy matching
    expect(canonicalSkill('TypeScript')).toBe('typescript');
    expect(canonicalSkill('ml')).toBe('machine learning');
    expect(canonicalSkill('Co-Founder')).toBe('founder');
    expect(canonicalSkill('C++')).toBe('c++');
    expect(canonicalSkill('.NET')).toBe('c#');
    expect(canonicalSkill('CI/CD')).toBe('ci/cd');
    expect(canonicalSkill('nope')).toBeNull();
    expect(canonicalSkill(42)).toBeNull();
    expect(canonicalSkill('')).toBeNull();
    expect(skillCategory('kubernetes')).toBe('cloud');
    expect(aliasTable().get('golang')).toBe('go');
    expect(SKILL_TAXONOMY.length).toBe(SKILL_DEFINITIONS.length);
  });

  it('normalises punctuation but keeps + # . & inside tokens', () => {
    expect(normalizeMatchText('Sr. Node.js/React dev — CI/CD, C++ & C#; co-founder (ex-Stripe)')).toBe(
      'sr node.js react dev ci cd c++ & c# co founder ex stripe',
    );
  });
});

describe('extractSkills (heuristic)', () => {
  it('extracts bounded skills from headline, role, notes and tags with evidence', () => {
    const r = extractSkills({
      id: '1',
      fullName: 'Ada',
      role: 'Staff TypeScript Engineer',
      notes: 'AWS, Docker and React. Mentor at a bootcamp.',
      tags: ['k8s'],
    });
    expect(r.skills).toEqual(['typescript', 'react', 'aws', 'docker', 'kubernetes', 'mentoring']);
    expect(r.mode).toBe('heuristic');
    expect(r.evidence.typescript).toEqual([{ field: 'role', matched: 'typescript', snippet: 'Staff TypeScript Engineer' }]);
    expect(r.evidence.kubernetes![0]).toMatchObject({ field: 'tags', matched: 'k8s' });
    expect(r.evidence.aws![0]!.snippet).toContain('AWS');
    // Taxonomy order, not discovery order.
    expect(r.skills).toEqual(SKILL_TAXONOMY.filter((s) => r.skills.includes(s)));
    // Role/headline hits are confidence 1; notes-only hits are 0.9.
    expect(r.details.find((d) => d.skill === 'typescript')!.confidence).toBe(1);
    expect(r.details.find((d) => d.skill === 'docker')!.confidence).toBe(0.9);
    expect(r.details.every((d) => d.source === 'heuristic')).toBe(true);
  });

  it('matches whole tokens only — never substrings', () => {
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'A javascripted process' }).skills).not.toContain('javascript');
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'Rusty old tools' }).skills).not.toContain('rust');
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'Fluent in Java and Kotlin' }).skills).toEqual(['java', 'kotlin']);
  });

  it('does not tag ordinary English as a skill in prose, but honours explicit tags', () => {
    const prose = extractSkills({
      id: '1',
      fullName: 'X',
      headline: 'Go-to-market lead who can excel at strategy and spark growth',
    });
    expect(prose.skills).toEqual([]);
    const tagged = extractSkills({ id: '1', fullName: 'X', tags: ['go', 'Excel', 'Spark'] });
    expect(tagged.skills).toEqual(['go', 'spark', 'excel']);
    // The unambiguous aliases DO count in prose.
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'Writes Golang; Apache Spark pipelines; Head of Growth' }).skills).toEqual([
      'go',
      'spark',
      'growth',
    ]);
  });

  it('prefers the longest alias at an offset (react native ≠ react) and handles separators', () => {
    const r = extractSkills({ id: '1', fullName: 'X', headline: 'React Native / Node.js engineer, ex co-founder, CI/CD nerd' });
    expect(r.skills).toEqual(['node.js', 'react native', 'ci/cd', 'founder']);
    expect(r.evidence['react native']![0]!.matched).toBe('react native');
    expect(r.evidence.founder![0]!.snippet).toContain('co-founder');
  });

  it('accepts tags/customFields as JSON arrays, JSON strings, objects and delimited strings', () => {
    expect(listValues(['a', 'b'])).toEqual(['a', 'b']);
    expect(listValues('["a","b"]')).toEqual(['a', 'b']);
    expect(listValues('a, b;c|d')).toEqual(['a', 'b', 'c', 'd']);
    expect(listValues({ Skills: 'Terraform', Other: ['Figma'] })).toEqual(['Terraform', 'Figma']);
    expect(listValues(null)).toEqual([]);
    expect(listValues('')).toEqual([]);
    const r = extractSkills({ id: '1', fullName: 'X', customFields: '{"Skills":"Terraform, Figma"}' });
    expect(r.skills).toEqual(['terraform', 'figma']);
    expect(r.evidence.terraform![0]!.field).toBe('customFields');
  });

  it('folds a stored verdict in as `stored` without letting it outrank evidence', () => {
    const r = extractSkills({ id: '1', fullName: 'X', headline: 'Python dev', skills: '["python","rust","not-a-skill"]' });
    expect(r.skills).toEqual(['python', 'rust']);
    expect(r.details.find((d) => d.skill === 'python')).toMatchObject({ source: 'heuristic', confidence: 1 });
    expect(r.details.find((d) => d.skill === 'rust')).toMatchObject({ source: 'stored', confidence: 0.8, evidence: [] });
    expect(storedSkills(['Kubernetes', 'k8s', 'bogus'])).toEqual(['kubernetes']);
    expect(storedSkills(null)).toEqual([]);
  });

  it('returns an empty extraction for an empty contact and survives huge notes', () => {
    expect(extractSkills({ id: '1', fullName: 'X' })).toMatchObject({ skills: [], details: [], evidence: {} });
    const big = 'lorem ipsum '.repeat(5000) + ' kubernetes';
    // Text past MAX_EXTRACT_CHARS is truncated (kubernetes sits beyond the cap).
    expect(extractSkills({ id: '1', fullName: 'X', notes: big }).skills).toEqual([]);
    expect(extractSkills({ id: '1', fullName: 'X', notes: 'kubernetes ' + big }).skills).toEqual(['kubernetes']);
  });
});

describe('AI extraction', () => {
  const fakeProvider = (reply: string | Error): AiProvider & { calls: number } => {
    const p = {
      id: 'openai' as const,
      label: 'fake',
      defaultModel: 'fake-1',
      calls: 0,
      async complete() {
        p.calls += 1;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    return p;
  };

  it('parses JSON arrays, fenced arrays and plain lists; drops anything outside the taxonomy', () => {
    expect(parseSkillReply('["kubernetes","typescript","unicorn wrangling"]')).toEqual(['typescript', 'kubernetes']);
    expect(parseSkillReply('```json\n["K8s"]\n```')).toEqual(['kubernetes']);
    expect(parseSkillReply('- rust\n- go\n- Excel')).toEqual(['go', 'rust', 'excel']);
    expect(parseSkillReply('[]')).toEqual([]);
    expect(parseSkillReply('I could not determine any skills.')).toEqual([]);
    expect(parseSkillReply(JSON.stringify(SKILL_TAXONOMY)).length).toBeLessThanOrEqual(AI_MAX_SKILLS);
  });

  it('the prompt only offers the taxonomy and the contact text', () => {
    const messages = buildSkillExtractionMessages({ id: '1', fullName: 'Ada', headline: 'Payments at Stripe' });
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('copied exactly from the allowed list');
    expect(messages[1]!.content).toContain(SKILL_TAXONOMY.join(', '));
    expect(messages[1]!.content).toContain('- headline: Payments at Stripe');
    expect(messages[1]!.content).not.toContain('Ada'); // the name is not evidence of a skill
  });

  it('merges AI picks below heuristic hits and tags them as ai', async () => {
    const provider = fakeProvider('["Kubernetes", "TypeScript", "made-up"]');
    const r = await extractSkillsWithAi({ id: '1', fullName: 'X', headline: 'TypeScript engineer' }, { provider });
    expect(r.mode).toBe('ai');
    expect(r.skills).toEqual(['typescript', 'kubernetes']);
    expect(r.details.find((d) => d.skill === 'typescript')).toMatchObject({ source: 'heuristic', confidence: 1 });
    expect(r.details.find((d) => d.skill === 'kubernetes')).toMatchObject({ source: 'ai', confidence: AI_SKILL_CONFIDENCE, evidence: [] });
    expect(r.aiError).toBeUndefined();
    expect(provider.calls).toBe(1);
  });

  it('degrades to the heuristic result when the provider fails, and says so', async () => {
    const provider = fakeProvider(new AiProviderError('upstream_error', 'HTTP 503'));
    const r = await extractSkillsWithAi({ id: '1', fullName: 'X', headline: 'TypeScript engineer' }, { provider });
    expect(r.skills).toEqual(['typescript']);
    expect(r.mode).toBe('ai');
    expect(r.aiError).toBe('upstream_error: HTTP 503');
  });

  it('does not call the model for a contact with no text at all', async () => {
    const provider = fakeProvider('["rust"]');
    const complete = vi.spyOn(provider, 'complete');
    const r = await extractSkillsWithAi({ id: '1', fullName: 'Nameless' }, { provider });
    expect(r.skills).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
