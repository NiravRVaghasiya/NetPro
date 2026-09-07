import { describe, expect, it } from 'vitest';
import { actionableMatches, matchAttendees, type MatchableContact } from './match';
import { canDiscover, DISABLED_EVENT_PROVIDER, resolveEventProvider } from './providers';
import { AUTO_MATCH_CONFIDENCE } from './types';

const contacts: MatchableContact[] = [
  { id: 'a', fullName: 'Ada Lovelace', email: 'ada@engines.dev' },
  { id: 'b', fullName: 'Bob Builder', email: 'bob@builders.io' },
  { id: 'c', fullName: 'Cara Chen', email: null },
  { id: 'd', fullName: 'José Álvarez', email: 'jose@spark.dev' },
];

describe('matchAttendees', () => {
  it('matches by email exactly, ignoring case and formatting', () => {
    const result = matchAttendees(
      [{ email: '  ADA@Engines.dev ' }, { email: 'mailto:bob@builders.io' }],
      contacts
    );
    expect(result.matched).toBe(2);
    expect(result.matches.map((m) => m.contactId)).toEqual(['a', 'b']);
    expect(result.matches[0]).toMatchObject({ status: 'matched', via: 'email', confidence: 1 });
  });

  it('matches by name when there is no email, folding accents and case', () => {
    const result = matchAttendees([{ name: 'cara chen' }, { name: 'Jose Alvarez' }], contacts);
    expect(result.matches.map((m) => m.contactId)).toEqual(['c', 'd']);
    expect(result.matches[1]).toMatchObject({ status: 'matched', via: 'name', confidence: 0.9 });
  });

  it('refuses to choose when the email and the name point at different people', () => {
    // Ada's address with Bob's name is contradictory evidence: picking the
    // email tier would quietly link the wrong person, so it comes back for a
    // human instead.
    const result = matchAttendees([{ email: 'ada@engines.dev', name: 'Bob Builder' }], contacts);
    expect(result.matches[0]!.status).toBe('ambiguous');
    expect(result.matches[0]!.contactId).toBeNull();
    expect(result.matches[0]!.candidates.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('flags a last-name + initial hit as review, never as an auto-link', () => {
    const result = matchAttendees([{ name: 'A Lovelace' }], contacts);
    expect(result.matched).toBe(0);
    expect(result.review).toBe(1);
    expect(result.matches[0]).toMatchObject({ status: 'review', via: 'initials', confidence: 0.6 });
    expect(result.matches[0]!.reason).toContain('confirm before linking');
    expect(actionableMatches(result)).toEqual([]);
    expect(actionableMatches(result, { includeReview: true })).toHaveLength(1);
  });

  it('returns ambiguity instead of picking between two people', () => {
    const dupes: MatchableContact[] = [
      { id: 's1', fullName: 'Sam Same', email: 'sam1@example.com' },
      { id: 's2', fullName: 'Sam Same', email: 'sam2@example.com' },
    ];
    const result = matchAttendees([{ name: 'Sam Same' }], dupes);
    expect(result.ambiguous).toBe(1);
    expect(result.matches[0]!.contactId).toBeNull();
    expect(result.matches[0]!.candidates.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(result.matches[0]!.reason).toContain('2 contacts match');
  });

  it('treats one contact reachable two ways as a match, not ambiguity', () => {
    const result = matchAttendees([{ email: 'ada@engines.dev', name: 'Ada Lovelace' }], contacts);
    expect(result.matches[0]!.status).toBe('matched');
    expect(result.ambiguous).toBe(0);
  });

  it('reports unmatched lines with a reason and no contact', () => {
    const result = matchAttendees([{ email: 'nobody@example.com' }, { name: 'Zoe Zodiac' }, {}], contacts);
    expect(result.unmatched).toBe(3);
    expect(result.matches[0]!.reason).toContain('no contact matches');
    expect(result.matches[2]!.reason).toBe('no email or name in that line');
  });

  it('keeps input order so a summary can be zipped against the file', () => {
    const refs = [{ name: 'Cara Chen' }, { email: 'ada@engines.dev' }, { name: 'Nobody' }];
    const result = matchAttendees(refs, contacts);
    expect(result.matches.map((m) => m.ref)).toEqual(refs);
  });

  it('honours a custom auto-link threshold', () => {
    const result = matchAttendees([{ name: 'A Lovelace' }], contacts, { autoConfidence: 0.5 });
    expect(result.matches[0]!.status).toBe('matched');
    expect(AUTO_MATCH_CONFIDENCE).toBe(0.9);
  });

  it('matches nothing against an empty network without throwing', () => {
    const result = matchAttendees([{ email: 'ada@engines.dev' }], []);
    expect(result.unmatched).toBe(1);
  });

  it('caps the candidate list it hands back', () => {
    const many: MatchableContact[] = Array.from({ length: 9 }, (_, i) => ({
      id: `x${i}`,
      fullName: 'Sam Same',
      email: `sam${i}@example.com`,
    }));
    const result = matchAttendees([{ name: 'Sam Same' }], many);
    expect(result.matches[0]!.candidates).toHaveLength(5);
  });
});

describe('event discovery providers', () => {
  it('ships disabled by default — no network in v2.0', () => {
    expect(DISABLED_EVENT_PROVIDER.enabled).toBe(false);
    expect(canDiscover(DISABLED_EVENT_PROVIDER)).toBe(false);
  });

  it('only accepts an enabled provider with a discover implementation', () => {
    expect(resolveEventProvider(null).name).toBe('disabled');
    expect(resolveEventProvider({ name: 'luma', enabled: false }).name).toBe('disabled');
    const live = { name: 'luma', enabled: true, discover: async () => [] };
    expect(resolveEventProvider(live).name).toBe('luma');
    expect(canDiscover(live)).toBe(true);
    expect(canDiscover({ name: 'broken', enabled: true })).toBe(false);
  });
});
