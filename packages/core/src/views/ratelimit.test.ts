import { describe, expect, it } from 'vitest';
import { BEACON_RATE_LIMIT, createRateLimiter } from './ratelimit';

describe('beacon rate limiting (v2.5 phase 2)', () => {
  it('exports the plan-mandated default of 60 requests per minute', () => {
    expect(BEACON_RATE_LIMIT.limit).toBe(60);
    expect(BEACON_RATE_LIMIT.windowMs).toBe(60_000);
  });

  it('allows up to the limit inside one window, then rejects', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 }, () => now);
    expect(limiter.allow('a', now)).toBe(true);
    expect(limiter.allow('a', now)).toBe(true);
    expect(limiter.allow('a', now)).toBe(true);
    expect(limiter.allow('a', now)).toBe(false);
    // The window slides: after it resets, the key is allowed again.
    now += 1001;
    expect(limiter.allow('a', now)).toBe(true);
  });

  it('tracks keys independently (one hammering IP cannot starve others)', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('rejects invalid configuration', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 10, windowMs: -5 })).toThrow(RangeError);
  });

  it('reset clears all buckets', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    limiter.reset();
    expect(limiter.allow('a')).toBe(true);
  });
});
