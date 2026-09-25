/**
 * The per-process model limiter (docs/plans/multi-user.md M5). Every model
 * run in the worker goes through one instance, which stands for the one
 * Anthropic organisation the API key belongs to: a global cap on runs in
 * flight, and a token bucket per principal under it. When a slot frees it
 * goes to the next principal in turn who is waiting and has a token, so a
 * principal with a hundred queued triage runs takes one slot in turn with
 * everyone else rather than all of them.
 */

export interface FairShareOptions {
  /** Runs in flight across every principal. */
  readonly concurrency: number;
  /** The most runs a principal can start at once after a quiet spell. */
  readonly burst: number;
  /** How fast a principal's bucket refills, in runs per minute. */
  readonly refillPerMinute: number;
  /** Injected in tests; milliseconds since the epoch. */
  readonly now?: () => number;
}

interface Bucket {
  tokens: number;
  refilledAt: number;
  waiting: (() => void)[];
}

export class FairShareLimiter {
  private readonly buckets = new Map<string, Bucket>();
  /** Principals in the order they first asked; the turn walks this ring. */
  private readonly ring: string[] = [];
  private turn = 0;
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: FairShareOptions) {
    if (options.concurrency < 1 || options.burst < 1 || options.refillPerMinute <= 0) {
      throw new Error(
        'The model limiter needs a concurrency and a burst of at least 1 and a positive refill rate; check MODEL_CONCURRENCY, MODEL_PRINCIPAL_BURST and MODEL_PRINCIPAL_RUNS_PER_MINUTE.',
      );
    }
    this.now = options.now ?? Date.now;
  }

  /** Runs `work` for `principalId` once a slot and a token are free. */
  async run<T>(principalId: string, work: () => Promise<T>): Promise<T> {
    await new Promise<void>((admit) => {
      this.bucketFor(principalId).waiting.push(admit);
      this.pump();
    });
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  /** Runs in flight and waiting, for tests and the Agents page. */
  snapshot(): { active: number; waiting: Record<string, number> } {
    const waiting: Record<string, number> = {};
    for (const [principalId, bucket] of this.buckets) {
      if (bucket.waiting.length > 0) waiting[principalId] = bucket.waiting.length;
    }
    return { active: this.active, waiting };
  }

  private bucketFor(principalId: string): Bucket {
    let bucket = this.buckets.get(principalId);
    if (bucket === undefined) {
      bucket = { tokens: this.options.burst, refilledAt: this.now(), waiting: [] };
      this.buckets.set(principalId, bucket);
      this.ring.push(principalId);
    }
    return bucket;
  }

  private refill(bucket: Bucket, at: number): void {
    const earned = ((at - bucket.refilledAt) / 60_000) * this.options.refillPerMinute;
    bucket.tokens = Math.min(this.options.burst, bucket.tokens + earned);
    bucket.refilledAt = at;
  }

  /** Admits waiting runs, one principal at a time in turn, while slots remain. */
  private pump(): void {
    const at = this.now();
    let starved = false;
    while (this.active < this.options.concurrency) {
      const next = this.nextInTurn(at);
      if (next === null) break;
      if (next === 'starved') {
        starved = true;
        break;
      }
      next.tokens -= 1;
      this.active += 1;
      next.waiting.shift()?.();
    }
    if (starved) this.wakeAtNextToken();
  }

  /** The next principal in the ring with a waiting run and a token. */
  private nextInTurn(at: number): Bucket | 'starved' | null {
    let anyWaiting = false;
    for (let step = 0; step < this.ring.length; step += 1) {
      const index = (this.turn + step) % this.ring.length;
      const bucket = this.buckets.get(this.ring[index] ?? '');
      if (bucket === undefined || bucket.waiting.length === 0) continue;
      anyWaiting = true;
      this.refill(bucket, at);
      if (bucket.tokens >= 1) {
        this.turn = index + 1;
        return bucket;
      }
    }
    return anyWaiting ? 'starved' : null;
  }

  /** Every waiting principal is out of tokens: try again when the first refills. */
  private wakeAtNextToken(): void {
    if (this.timer !== null) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) {
      if (bucket.waiting.length === 0) continue;
      const needed = 1 - bucket.tokens;
      soonest = Math.min(soonest, (needed / this.options.refillPerMinute) * 60_000);
    }
    const delay = Math.max(1, Math.ceil(soonest));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
  }
}
