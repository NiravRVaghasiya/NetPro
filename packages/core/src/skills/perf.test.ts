// Performance budget for the v2.0 Phase 5 skills analyzer. The plan sets no
// explicit number for this phase, so the budget is inherited from the
// dashboard rule the graph work used ("< 500 ms for a page load") applied to
// the two things a page does: extract every contact and aggregate the gaps.
// The test asserts a CI-safe multiple and records the actual measurement; the
// progress doc carries the number this machine reported.
import { describe, expect, it } from 'vitest';
import { extractSkills } from './extract';
import { analyzeNetworkGaps, networkSkillCounts } from './gap';
import { SKILL_TAXONOMY } from './taxonomy';
import type { SkillContact } from './extract';

/** Deterministic LCG — stable synthetic contacts across runs and machines. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const HEADLINES = [
  'Staff engineer — Python, Kubernetes and AWS',
  'Product designer (Figma, design systems)',
  'Data engineer building pipelines with Spark SQL and dbt',
  'Engineering manager, platform · Go-to-market obsessive',
  'Founder & CEO, ex-Stripe',
  'Security engineer — AppSec, cloud security, threat modelling',
  'Frontend developer: React, TypeScript, Next.js',
  'ML engineer — PyTorch, NLP, LLMs',
  'Head of Sales (enterprise, SaaS)',
  'iOS developer (Swift, SwiftUI)',
];

function syntheticContacts(count: number): Array<SkillContact & { relationshipScore: number }> {
  const rand = rng(7);
  return Array.from({ length: count }, (_, i) => {
    const words: string[] = [];
    // ~60 words of notes with a handful of taxonomy names sprinkled in.
    for (let w = 0; w < 60; w++) {
      words.push(rand() < 0.08 ? SKILL_TAXONOMY[Math.floor(rand() * SKILL_TAXONOMY.length)]! : `word${Math.floor(rand() * 500)}`);
    }
    return {
      id: `c${String(i).padStart(5, '0')}`,
      fullName: `Contact ${i}`,
      headline: HEADLINES[i % HEADLINES.length]!,
      role: i % 3 === 0 ? 'Senior Software Engineer' : null,
      department: i % 5 === 0 ? 'Engineering' : null,
      industry: i % 4 === 0 ? 'Fintech' : null,
      notes: words.join(' '),
      tags: i % 2 === 0 ? ['mentor', 'k8s'] : null,
      customFields: i % 6 === 0 ? { certifications: 'AWS Solutions Architect' } : null,
      skills: null,
      relationshipScore: Math.round(rand() * 100) / 100,
    };
  });
}

describe('skills performance budget', () => {
  it('5,000 contacts: extraction + network gap analysis stay inside budget', () => {
    const contacts = syntheticContacts(5_000);

    const t0 = performance.now();
    let total = 0;
    for (const c of contacts) total += extractSkills(c).skills.length;
    const extractMs = performance.now() - t0;
    expect(total).toBeGreaterThan(contacts.length); // the fixture really carries skills

    const t1 = performance.now();
    const analysis = analyzeNetworkGaps(
      { role: 'Staff Data Engineer', description: 'Python, Kubernetes, dbt and AWS; security a plus.', skills: 'react,figma' },
      contacts,
    );
    const gapMs = performance.now() - t1;
    expect(analysis.required.length).toBeGreaterThanOrEqual(6);
    expect(analysis.candidates.length).toBe(10);

    const t2 = performance.now();
    const map = networkSkillCounts(contacts, { limit: 40 });
    const mapMs = performance.now() - t2;
    expect(map.counts.length).toBe(40);

    console.info(
      `[skills perf] 5,000 contacts: extract ${extractMs.toFixed(0)} ms · gap ${gapMs.toFixed(0)} ms · map ${mapMs.toFixed(0)} ms`,
    );
    // Budget: 500 ms per operation on a laptop; asserted at 6× for slow CI runners.
    expect(extractMs).toBeLessThan(3_000);
    expect(gapMs).toBeLessThan(3_000);
    expect(mapMs).toBeLessThan(3_000);
  });
});
