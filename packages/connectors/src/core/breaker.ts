import { CircuitOpenError, type ConnectorName } from './errors.js';
import { systemClock, type Clock } from './rateLimit.js';

export interface BreakerPolicy {
  /** Consecutive failures that open the breaker. Spec 7.1 says three. */
  failureThreshold: number;
  /** How long the breaker stays open before one probe call is allowed. */
  halfOpenAfterMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerEvents {
  /** A tripped breaker is an alert, never a silent skip (spec 3.3). */
  onOpen?: (connector: ConnectorName, lastError: unknown) => void | Promise<void>;
  onClose?: (connector: ConnectorName) => void | Promise<void>;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly connector: ConnectorName,
    private readonly policy: BreakerPolicy,
    private readonly events: BreakerEvents = {},
    private readonly clock: Clock = systemClock,
  ) {}

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.clock.now() - this.openedAt >= this.policy.halfOpenAfterMs ? 'half_open' : 'open';
  }

  reopensAt(): Date | null {
    return this.openedAt === null ? null : new Date(this.openedAt + this.policy.halfOpenAfterMs);
  }

  consecutiveFailures(): number {
    return this.failures;
  }

  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const state = this.state();
    if (state === 'open' || (state === 'half_open' && this.probing)) {
      throw new CircuitOpenError(
        this.connector,
        operation,
        this.reopensAt() ?? new Date(this.clock.now()),
      );
    }
    if (state === 'half_open') this.probing = true;
    try {
      const value = await fn();
      await this.recordSuccess();
      return value;
    } catch (error) {
      await this.recordFailure(error);
      throw error;
    } finally {
      this.probing = false;
    }
  }

  private async recordSuccess(): Promise<void> {
    const wasOpen = this.openedAt !== null;
    this.failures = 0;
    this.openedAt = null;
    if (wasOpen) await this.events.onClose?.(this.connector);
  }

  private async recordFailure(error: unknown): Promise<void> {
    this.failures += 1;
    const alreadyOpen = this.openedAt !== null;
    if (this.failures >= this.policy.failureThreshold) {
      this.openedAt = this.clock.now();
      if (!alreadyOpen) await this.events.onOpen?.(this.connector, error);
    }
  }

  /** Manual reset from the Agents page or `/lance` in a later phase. */
  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }
}
