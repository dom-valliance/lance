export interface RateLimitPolicy {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  /** Longest a caller waits for a token before failing. */
  maxWaitMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Token bucket. Each connector has one so a burst from triage cannot exceed
 * the remote's published limits (spec 3.3). Waiting is cooperative: callers
 * queue on time, not on a lock.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = policy.capacity;
    this.lastRefill = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.policy.capacity,
      this.tokens + elapsedSeconds * this.policy.refillPerSecond,
    );
    this.lastRefill = now;
  }

  /** Resolves when a token has been taken; rejects after maxWaitMs. */
  async take(): Promise<void> {
    const deadline = this.clock.now() + this.policy.maxWaitMs;
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficitMs = ((1 - this.tokens) / this.policy.refillPerSecond) * 1000;
      if (this.clock.now() + deficitMs > deadline) {
        throw new Error(
          `Rate limit wait exceeded ${this.policy.maxWaitMs} ms; the connector is being called faster than its limit of ${this.policy.refillPerSecond} per second.`,
        );
      }
      await this.clock.sleep(Math.ceil(deficitMs));
    }
  }

  /** For status pages and tests. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}
