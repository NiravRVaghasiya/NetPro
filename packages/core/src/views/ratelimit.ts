// v2.5 Phase 2 — in-memory rate limiting for the profile-view beacons.
//
// The public beacon endpoints are open by design (no auth, no cookies), so
// abuse control lives here: **60 requests per minute per IP hash**, as the
// Phase 2 plan specifies. The implementation is a per-key fixed-window
// counter — a token bucket's hard-cap semantics with less bookkeeping —
// keyed by the viewer's daily-salted IP hash (never the raw IP, so the
// bucket never learns anything the privacy layer did not already permit).
//
// In-memory on purpose: the plan calls for "in-memory token bucket, no
// Redis". On multi-instance serverless deploys the limit is per-instance,
// which bounds — but does not replace — per-request hardening (caps,
// sanitization, dedup); the endpoints write one small row at most, so the
// residual blast radius of a bypass is one row of junk per request.
export const BEACON_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export interface RateLimiterOptions {
  /** Maximum allowed requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimiter {
  /** Allow the request for `key` at `now` (ms). False when over budget. */
  allow(key: string, now?: number): boolean;
  /** Drop every bucket (tests, and process restarts do it naturally). */
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Create a fixed-window limiter. Keys are bounded: once the map exceeds
 * 10k keys, expired buckets are swept — a spoofed-IP flood cannot grow the
 * map without bound.
 */
export function createRateLimiter(
  options: RateLimiterOptions,
  nowFn: () => number = Date.now,
): RateLimiter {
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new RangeError(`limit must be a positive number, got ${options.limit}`);
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
    throw new RangeError(`windowMs must be a positive number, got ${options.windowMs}`);
  }
  const buckets = new Map<string, Bucket>();
  const SWEEP_THRESHOLD = 10_000;

  return {
    allow(key, nowArg) {
      const now = nowArg ?? nowFn();
      let bucket = buckets.get(key);
      if (bucket === undefined || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + options.windowMs };
        buckets.set(key, bucket);
        if (buckets.size > SWEEP_THRESHOLD) {
          for (const [k, b] of buckets) {
            if (now >= b.resetAt) buckets.delete(k);
          }
        }
      }
      bucket.count += 1;
      return bucket.count <= options.limit;
    },
    reset() {
      buckets.clear();
    },
  };
}
