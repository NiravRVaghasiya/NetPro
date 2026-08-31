import { describe, it, expect } from 'vitest';
import { normalizeName, normalizeCompany, normalizeTitle, generateFingerprint, mergeContacts, type NormalizedContact } from './normalize';

describe('normalizeName', () => {
  it('uses firstName/lastName directly when present', () => {
    expect(normalizeName({ firstName: 'Jane', lastName: 'Doe', raw: {} })).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
    });
  });

  it('splits a "Last, First" fullName', () => {
    expect(normalizeName({ fullName: 'Doe, Jane', raw: {} })).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Doe, Jane',
    });
  });
});

describe('normalizeCompany', () => {
  it('strips common company suffixes', () => {
    expect(normalizeCompany('Acme Inc.')).toEqual({ company: 'Acme' });
    expect(normalizeCompany('Stripe, Inc.')).toEqual({ company: 'Stripe' });
  });

  it('handles undefined', () => {
    expect(normalizeCompany(undefined)).toEqual({});
  });
});

describe('normalizeTitle', () => {
  it('extracts seniority from title', () => {
    expect(normalizeTitle('Senior Software Engineer')).toEqual({
      role: 'Software Engineer',
      seniority: 'senior',
    });
  });

  it('handles VP-level titles', () => {
    expect(normalizeTitle('VP of Engineering')).toEqual({
      role: 'of Engineering',
      seniority: 'vp',
    });
  });

  it('defaults to mid seniority', () => {
    expect(normalizeTitle('Product Manager')).toEqual({
      role: 'Product Manager',
      seniority: 'mid',
    });
  });

  it('handles empty input', () => {
    expect(normalizeTitle(undefined)).toEqual({});
  });
});

describe('generateFingerprint', () => {
  it('prioritizes email', () => {
    expect(generateFingerprint({ email: 'Jane@Example.COM', fullName: 'Jane Doe' }))
      .toBe('email:jane@example.com');
  });

  it('falls back to name+company', () => {
    expect(generateFingerprint({ fullName: 'Jane Doe', company: 'Stripe' }))
      .toBe('name:janedoe|company:stripe');
  });
});

describe('mergeContacts', () => {
  it('prefers non-null incoming values, keeps existing when incoming is missing', () => {
    const existing: NormalizedContact = {
      fullName: 'Jane', firstName: 'Jane', lastName: '',
      email: 'jane@old.com', company: undefined, role: undefined, seniority: undefined,
      location: undefined, fingerprint: 'email:jane@old.com',
    };
    const incoming: NormalizedContact = {
      fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe',
      email: undefined, company: 'Stripe', role: undefined, seniority: undefined,
      location: undefined, fingerprint: 'email:jane@old.com',
    };

    const merged = mergeContacts(existing, incoming);
    expect(merged.fullName).toBe('Jane Doe');
    expect(merged.email).toBe('jane@old.com');
    expect(merged.company).toBe('Stripe');
  });
});
