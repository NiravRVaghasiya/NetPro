import { describe, expect, it } from 'vitest';
import { EMPTY_UTM, UTM_MAX_LENGTH, mergeUtm, parseUtm } from './utm';

describe('UTM attribution parsing (v2.5 phase 2)', () => {
  it('extracts the three stored fields from a full URL', () => {
    expect(
      parseUtm('https://x.com/post/1?utm_source=twitter&utm_medium=social&utm_campaign=launch'),
    ).toEqual({ source: 'twitter', medium: 'social', campaign: 'launch' });
  });

  it('also accepts a bare query string and parsed params', () => {
    expect(parseUtm('utm_source=blog&utm_medium=rss')).toEqual({
      source: 'blog',
      medium: 'rss',
      campaign: null,
    });
    expect(
      parseUtm(new URLSearchParams({ utm_campaign: 'q3' })),
    ).toEqual({ source: null, medium: null, campaign: 'q3' });
  });

  it('trims and caps every value at 100 chars', () => {
    const long = 's'.repeat(UTM_MAX_LENGTH + 50);
    const values = parseUtm(`?utm_source=${long}&utm_medium=m`);
    expect(values.source).toHaveLength(UTM_MAX_LENGTH);
    expect(values.medium).toBe('m');
  });

  it('ignores utm_term/utm_content (no column) and treats empties as null', () => {
    expect(
      parseUtm('?utm_source=%20%20&utm_medium=&utm_term=ignored&utm_content=also'),
    ).toEqual(EMPTY_UTM);
  });

  it('never throws on garbage and returns nulls for missing input', () => {
    expect(parseUtm(null)).toEqual(EMPTY_UTM);
    expect(parseUtm(undefined)).toEqual(EMPTY_UTM);
    expect(parseUtm('')).toEqual(EMPTY_UTM);
    expect(parseUtm(':::not%a%url?')).toEqual(EMPTY_UTM);
  });

  it('mergeUtm: the first non-null value wins per field', () => {
    const merged = mergeUtm(
      { source: 'explicit', medium: null, campaign: null },
      { source: 'referrer', medium: 'social', campaign: 'launch' },
    );
    expect(merged).toEqual({ source: 'explicit', medium: 'social', campaign: 'launch' });
  });
});
