import { describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  rateLimitKey,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from './rate-limit';

function config(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return { enabled: true, max: 3, windowMs: 1000, ...overrides };
}

describe('rate limiter (phase 23)', () => {
  it('allows up to max requests per peer per window, then 429s with a retry delay', () => {
    const limiter = createRateLimiter(config({ max: 2, windowMs: 1000 }));
    expect(limiter.check('127.0.0.1', 0)).toEqual({ allowed: true });
    expect(limiter.check('127.0.0.1', 1)).toEqual({ allowed: true });
    const denied = limiter.check('127.0.0.1', 2);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
    }
    // A different peer has its own window.
    expect(limiter.check('10.0.0.2', 2)).toEqual({ allowed: true });
    // The window resets.
    expect(limiter.check('127.0.0.1', 1000)).toEqual({ allowed: true });
  });

  it('does no limiting when disabled and resets on demand', () => {
    const limiter = createRateLimiter(config({ enabled: false, max: 1 }));
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('peer', i)).toEqual({ allowed: true });
    }
    expect(limiter.size()).toBe(0);

    const limited = createRateLimiter(config({ max: 1, windowMs: 60_000 }));
    expect(limited.check('peer', 0)).toEqual({ allowed: true });
    expect(limited.check('peer', 1).allowed).toBe(false);
    limited.reset();
    expect(limited.size()).toBe(0);
    expect(limited.check('peer', 1)).toEqual({ allowed: true });
  });

  it('normalizes peer addresses and buckets unknown peers together', () => {
    expect(rateLimitKey('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(rateLimitKey('[::1]')).toBe('::1');
    expect(rateLimitKey('  10.0.0.1  ')).toBe('10.0.0.1');
    expect(rateLimitKey(undefined)).toBe('unknown');
    expect(rateLimitKey(null)).toBe('unknown');
    expect(rateLimitKey('')).toBe('unknown');
  });

  it('resolves config from the environment, defaulting to on with 600/min', () => {
    expect(resolveRateLimitConfig({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      max: 600,
      windowMs: 60_000,
    });
    expect(
      resolveRateLimitConfig({ NETPRO_RATE_LIMIT_MAX: '10', NETPRO_RATE_LIMIT_WINDOW_MS: '5000' })
    ).toEqual({ enabled: true, max: 10, windowMs: 5000 });
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(resolveRateLimitConfig({ NETPRO_RATE_LIMIT_ENABLED: off }).enabled).toBe(false);
    }
    expect(resolveRateLimitConfig({ NETPRO_RATE_LIMIT_ENABLED: 'yes' }).enabled).toBe(true);
    // Garbage numbers fall back to the safe default, never to unlimited.
    expect(resolveRateLimitConfig({ NETPRO_RATE_LIMIT_MAX: 'lots' })).toEqual({
      enabled: true,
      max: 600,
      windowMs: 60_000,
    });
    expect(resolveRateLimitConfig({ NETPRO_RATE_LIMIT_MAX: '-5' }).max).toBe(600);
  });
});
