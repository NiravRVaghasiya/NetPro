// Phase 23 — per-IP fixed-window rate limiting for the standalone server.
//
// Local-first NetPro answers its owner on loopback, but the same process can
// be deliberately exposed (`netpro serve --host 0.0.0.0`, Docker, a reverse
// proxy). The limiter bounds how much work any single peer can demand: abuse,
// runaway polling loops, and credential-guessing all collapse into 429s with
// a Retry-After instead of unbounded handler time.
//
// Design notes:
//   • Fixed window per normalized peer address. No storage, no clock beyond
//     Date.now(), no cross-process state — a local server does not need a
//     Redis counter, and two processes behind a proxy each enforce their own.
//   • Generous default (600 requests/minute/peer): the Observatory (SSE plus
//     polling) never notices, while a tight loop trips within seconds.
//   • Probes are exempt at the dispatch layer (/api/health, /api/server-info,
//     OPTIONS): an orchestrator must never read a limit as an outage.
//   • Disabled explicitly with NETPRO_RATE_LIMIT_ENABLED=0 — the default is
//     on, because remote exposure must be safe without extra homework.

export type RateLimitConfig = {
  enabled: boolean;
  /** Requests allowed per peer per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Resolve the limiter from the environment:
 * - `NETPRO_RATE_LIMIT_ENABLED` — on unless 0/false/no/off
 * - `NETPRO_RATE_LIMIT_MAX` — requests per window (default 600)
 * - `NETPRO_RATE_LIMIT_WINDOW_MS` — window length (default 60000)
 */
export function resolveRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const raw = env.NETPRO_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  const enabled = raw === undefined || raw === '' ? true : !/^(0|false|no|off)$/.test(raw);
  return {
    enabled,
    max: positiveInt(env.NETPRO_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    windowMs: positiveInt(env.NETPRO_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
  };
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type RateLimiter = {
  /** Check (and consume) one request for `key`. Pure besides the counters. */
  check(key: string, now?: number): RateLimitDecision;
  /** Drop all counters (tests, and operators who just fixed a loop). */
  reset(): void;
  /** Number of tracked peers (introspection). */
  size(): number;
};

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string, now: number = Date.now()): RateLimitDecision {
      if (!config.enabled) return { allowed: true };
      const slot = windows.get(key);
      if (!slot || now >= slot.resetAt) {
        // Opportunistic prune so a port scan cannot grow the map forever.
        if (windows.size > 5000) {
          for (const [peer, window] of windows) {
            if (now >= window.resetAt) windows.delete(peer);
          }
        }
        windows.set(key, { count: 1, resetAt: now + config.windowMs });
        return { allowed: true };
      }
      if (slot.count < config.max) {
        slot.count += 1;
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: Math.max(0, slot.resetAt - now) };
    },
    reset(): void {
      windows.clear();
    },
    size(): number {
      return windows.size;
    },
  };
}

/** Normalize a socket peer into a limiter key (unknown peers share one bucket). */
export function rateLimitKey(remoteAddress?: string | null): string {
  const value = (remoteAddress ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === '' ? 'unknown' : value;
}
