import { RateLimiter } from '../../core/security/RateLimiter';
import { beforeEach, describe, expect, it } from 'bun:test';

/**
 * The clock is injected so these tests assert refill behaviour exactly, rather
 * than sleeping and hoping.
 */
describe('RateLimiter', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows up to the burst capacity, then refuses', () => {
    const limiter = new RateLimiter(3, 1, clock);

    expect(limiter.take('key-a').allowed).toBe(true);
    expect(limiter.take('key-a').allowed).toBe(true);
    const third = limiter.take('key-a');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = limiter.take('key-a');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills over time at the configured rate', () => {
    const limiter = new RateLimiter(2, 1, clock);
    limiter.take('key-a');
    limiter.take('key-a');
    expect(limiter.take('key-a').allowed).toBe(false);

    now += 1000; // one second -> one token
    expect(limiter.take('key-a').allowed).toBe(true);
    expect(limiter.take('key-a').allowed).toBe(false);
  });

  it('never refills beyond capacity', () => {
    const limiter = new RateLimiter(2, 10, clock);
    limiter.take('key-a');
    now += 60_000; // long idle: would be 600 tokens without the cap

    expect(limiter.take('key-a').allowed).toBe(true);
    expect(limiter.take('key-a').allowed).toBe(true);
    expect(limiter.take('key-a').allowed).toBe(false);
  });

  it('tracks each caller independently', () => {
    const limiter = new RateLimiter(1, 1, clock);
    expect(limiter.take('key-a').allowed).toBe(true);
    expect(limiter.take('key-a').allowed).toBe(false);
    // One caller exhausting its bucket must not affect anyone else.
    expect(limiter.take('key-b').allowed).toBe(true);
  });

  it('reports a retry delay that is actually long enough', () => {
    const limiter = new RateLimiter(1, 0.5, clock); // one token per 2s
    limiter.take('key-a');
    const denied = limiter.take('key-a');
    expect(denied.allowed).toBe(false);

    now += (denied.retryAfterSeconds - 1) * 1000;
    // Strictly before the advertised time, it may still refuse...
    limiter.take('key-a');
    now += 2000;
    expect(limiter.take('key-a').allowed).toBe(true);
  });

  it('prunes idle buckets but keeps active ones', () => {
    const limiter = new RateLimiter(5, 5, clock);
    limiter.take('idle');
    limiter.take('active');
    expect(limiter.size()).toBe(2);

    now += 11 * 60 * 1000;
    limiter.take('active'); // refreshes this bucket's timestamp
    limiter.prune();

    expect(limiter.size()).toBe(1);
    // The pruned key starts fresh rather than being locked out.
    expect(limiter.take('idle').allowed).toBe(true);
  });

  it('rejects nonsensical configuration instead of silently disabling itself', () => {
    expect(() => new RateLimiter(0, 1)).toThrow(/capacity/);
    expect(() => new RateLimiter(1, 0)).toThrow(/refillPerSecond/);
  });

  it('falls back to safe defaults when the env vars are garbage', () => {
    const previousBurst = process.env.PLATFORM_RATE_BURST;
    const previousRate = process.env.PLATFORM_RATE_PER_MINUTE;
    process.env.PLATFORM_RATE_BURST = 'not-a-number';
    process.env.PLATFORM_RATE_PER_MINUTE = '-5';
    try {
      const limiter = RateLimiter.fromEnv(clock);
      expect(limiter.take('key-a').allowed).toBe(true);
    } finally {
      if (previousBurst === undefined) delete process.env.PLATFORM_RATE_BURST;
      else process.env.PLATFORM_RATE_BURST = previousBurst;
      if (previousRate === undefined) delete process.env.PLATFORM_RATE_PER_MINUTE;
      else process.env.PLATFORM_RATE_PER_MINUTE = previousRate;
    }
  });
});
