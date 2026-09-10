/**
 * Per-caller token bucket.
 *
 * Investigation is the expensive path in this platform: every query runs a
 * semantic search, a two-hop graph expansion, and — for aggregate queries — a
 * real child `node` process inside the sandboxed Executor. Without a limit,
 * one API key can spawn those processes as fast as it can issue requests,
 * which is a denial-of-service against the whole platform rather than a
 * clever attack. Guardrails already vet *what* a query asks; this limits *how
 * often* any one caller may ask.
 *
 * In-memory and per-process, which is the honest scope of it: it protects a
 * single API instance, and several instances behind a load balancer would
 * each enforce their own bucket. A shared store (Redis) is the production
 * shape — see docs/analyst-architecture.md "Known limitations".
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this decision. */
  remaining: number;
  /** Seconds until at least one token is available again. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param capacity   Maximum burst — tokens the bucket holds when full.
   * @param refillPerSecond  Sustained rate, in tokens per second.
   * @param now        Injectable clock, so the tests do not have to sleep.
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity <= 0) throw new Error('RateLimiter capacity must be > 0');
    if (refillPerSecond <= 0) throw new Error('RateLimiter refillPerSecond must be > 0');
  }

  static fromEnv(now: () => number = Date.now): RateLimiter {
    const capacity = Number(process.env.PLATFORM_RATE_BURST ?? 20);
    const perMinute = Number(process.env.PLATFORM_RATE_PER_MINUTE ?? 60);
    return new RateLimiter(
      Number.isFinite(capacity) && capacity > 0 ? capacity : 20,
      (Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 60) / 60,
      now,
    );
  }

  /** Consumes one token for `key`, reporting whether the call may proceed. */
  take(key: string): RateLimitDecision {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };

    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.refillPerSecond)),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  /**
   * Drops buckets that have been full (i.e. idle) for a while, so a long-lived
   * server does not accumulate one entry per key it has ever seen.
   */
  prune(idleMs = 10 * 60 * 1000): void {
    const nowMs = this.now();
    for (const [key, bucket] of this.buckets) {
      const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1000;
      if (bucket.tokens + elapsedSeconds * this.refillPerSecond >= this.capacity && nowMs - bucket.lastRefillMs > idleMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** Test/introspection helper: how many keys currently hold a bucket. */
  size(): number {
    return this.buckets.size;
  }
}
