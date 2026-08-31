export class LocalRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(private config: { defaultRate: number; windowMs: number }) {}

  consume(key: string, tokens = 1): { allowed: boolean; remaining: number } {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.config.defaultRate, this.config.windowMs);
      this.buckets.set(key, bucket);
    }
    const result = bucket.consume(tokens);
    return { allowed: result.consumed, remaining: result.remaining };
  }
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  consume(count: number): { consumed: boolean; remaining: number } {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return { consumed: true, remaining: this.tokens };
    }
    return { consumed: false, remaining: this.tokens };
  }

  private refill(): void {
    const now = Date.now();
    if (now - this.lastRefill >= this.refillMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}
