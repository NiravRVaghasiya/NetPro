import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalRateLimiter } from './rate-limiter';

describe('LocalRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit, then denies', () => {
    const limiter = new LocalRateLimiter({ defaultRate: 2, windowMs: 60_000 });

    expect(limiter.consume('hunter').allowed).toBe(true);
    expect(limiter.consume('hunter').allowed).toBe(true);
    expect(limiter.consume('hunter').allowed).toBe(false);
  });

  it('tracks separate buckets per key', () => {
    const limiter = new LocalRateLimiter({ defaultRate: 1, windowMs: 60_000 });

    expect(limiter.consume('hunter').allowed).toBe(true);
    expect(limiter.consume('pdl').allowed).toBe(true);
  });

  it('refills after the window elapses', () => {
    vi.useFakeTimers();
    const limiter = new LocalRateLimiter({ defaultRate: 1, windowMs: 1000 });

    expect(limiter.consume('hunter').allowed).toBe(true);
    expect(limiter.consume('hunter').allowed).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(limiter.consume('hunter').allowed).toBe(true);
  });
});
