import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rateLimit.js';
import { FakeClock } from './testing.js';

describe('TokenBucket', () => {
  it('serves a burst up to capacity without waiting', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, maxWaitMs: 10_000 }, clock);
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(clock.sleeps).toEqual([]);
    expect(bucket.available()).toBe(0);
  });

  it('waits for the refill when the bucket is empty', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 2, maxWaitMs: 10_000 }, clock);
    await bucket.take();
    await bucket.take();
    expect(clock.sleeps).toEqual([500]);
  });

  it('refuses when the wait would exceed the ceiling', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.1, maxWaitMs: 1000 }, clock);
    await bucket.take();
    await expect(bucket.take()).rejects.toThrow(/Rate limit wait exceeded 1000 ms/);
  });

  it('never refills above capacity', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100, maxWaitMs: 1000 }, clock);
    clock.advance(60_000);
    expect(bucket.available()).toBe(2);
  });
});
