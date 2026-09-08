import { describe, expect, it } from 'vitest';
import { REFERRER_MAX_LENGTH, parseReferrer } from './referrer';

describe('referrer sanitization (v2.5 phase 2)', () => {
  it('keeps scheme://host/path and strips query, hash, and credentials', () => {
    expect(parseReferrer('https://linkedin.com/in/ada?utm_source=x&token=SECRET#top')).toBe(
      'https://linkedin.com/in/ada',
    );
    expect(parseReferrer('http://blog.example/post/42')).toBe('http://blog.example/post/42');
    // Credentials in a referrer are a leak — drop the value entirely.
    expect(parseReferrer('https://user:pass@example.com/')).toBeNull();
  });

  it('never stores query tokens, including ?v= contact-resolution tokens', () => {
    const value = parseReferrer('https://blog.example/?v=abc123&next=/card');
    expect(value).toBe('https://blog.example/');
    expect(value).not.toContain('v=');
  });

  it('caps the stored value at the documented length', () => {
    const longPath = '/'.repeat(120) + 'a'.repeat(200);
    const value = parseReferrer(`https://example.com${longPath}`);
    expect(value).not.toBeNull();
    expect(value!.length).toBeLessThanOrEqual(REFERRER_MAX_LENGTH);
  });

  it('rejects relative URLs, non-HTTP schemes, and garbage', () => {
    expect(parseReferrer('/card')).toBeNull();
    expect(parseReferrer('javascript:alert(1)')).toBeNull();
    expect(parseReferrer('data:text/html;base64,xxx')).toBeNull();
    expect(parseReferrer('file:///etc/passwd')).toBeNull();
    expect(parseReferrer('not a url at all')).toBeNull();
    expect(parseReferrer('https://')).toBeNull();
    expect(parseReferrer('')).toBeNull();
    expect(parseReferrer(null)).toBeNull();
    expect(parseReferrer(undefined)).toBeNull();
  });

  it('tolerates surrounding whitespace and keeps unicode hosts punycode-safe', () => {
    expect(parseReferrer('  https://example.com/path  ')).toBe('https://example.com/path');
    const value = parseReferrer('https://exämple.com/ü');
    expect(value).not.toBeNull();
    expect(value!.includes(' ')).toBe(false);
  });
});
