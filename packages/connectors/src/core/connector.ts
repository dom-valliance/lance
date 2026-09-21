import { hashRecord } from '@lance/shared';
import {
  ATTR_CONNECTOR,
  ATTR_CORRELATION_ID,
  ATTR_PROPOSAL_ID,
  ATTR_REQUEST_HASH,
  withSpan,
} from '@lance/telemetry';
import {
  CircuitBreaker,
  type BreakerEvents,
  type BreakerPolicy,
  type BreakerState,
} from './breaker.js';
import type { ConnectorName } from './errors.js';
import { TokenBucket, systemClock, type Clock, type RateLimitPolicy } from './rateLimit.js';
import { retryWithJitter, type RetryPolicy } from './retry.js';

export interface ConnectorPolicy {
  rateLimit: RateLimitPolicy;
  retry: RetryPolicy;
  breaker: BreakerPolicy;
}

export interface CallContext {
  correlationId?: string;
  proposalId?: string;
  /** Anything that identifies the request without its body: path, ids, query. Hashed into the span. */
  request?: unknown;
}

export interface CallRecord {
  connector: ConnectorName;
  operation: string;
  kind: 'read' | 'write';
  ok: boolean;
  status: number | undefined;
  attempts: number;
  durationMs: number;
}

export interface ConnectorEvents extends BreakerEvents {
  onCall?: (record: CallRecord) => void | Promise<void>;
}

export interface ConnectorOptions {
  name: ConnectorName;
  policy: ConnectorPolicy;
  events?: ConnectorEvents;
  clock?: Clock;
}

export interface Connector {
  readonly name: ConnectorName;
  /** Wraps one remote read: span, rate limit, breaker, retry. */
  read<T>(operation: string, context: CallContext, fn: (attempt: number) => Promise<T>): Promise<T>;
  /**
   * Wraps one remote write. Same wrapper; the distinction is recorded so the
   * ledger and the Agents page can tell them apart. Only the executor may
   * reach a write (ESLint boundary on the writes entry point).
   */
  write<T>(
    operation: string,
    context: CallContext,
    fn: (attempt: number) => Promise<T>,
  ): Promise<T>;
  breakerState(): BreakerState;
  resetBreaker(): void;
  availableTokens(): number;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}

/**
 * Every outbound call to Graph, Jamie, Notion or Slack goes through here
 * (spec 3.3, 8): per-connector rate limit, retries with jitter, a circuit
 * breaker whose opening is an event, and an OTel span carrying the request
 * hash and the outcome. Nothing here logs a body or a token.
 */
export function defineConnector(options: ConnectorOptions): Connector {
  const clock = options.clock ?? systemClock;
  const limiter = new TokenBucket(options.policy.rateLimit, clock);
  const breaker = new CircuitBreaker(
    options.name,
    options.policy.breaker,
    options.events ?? {},
    clock,
  );

  const call = async <T>(
    kind: 'read' | 'write',
    operation: string,
    context: CallContext,
    fn: (attempt: number) => Promise<T>,
  ): Promise<T> => {
    const attributes: Record<string, string> = {
      [ATTR_CONNECTOR]: options.name,
      'lance.operation': operation,
      'lance.call_kind': kind,
    };
    if (context.correlationId) attributes[ATTR_CORRELATION_ID] = context.correlationId;
    if (context.proposalId) attributes[ATTR_PROPOSAL_ID] = context.proposalId;
    if (context.request !== undefined) attributes[ATTR_REQUEST_HASH] = hashRecord(context.request);

    return withSpan(`${options.name}.${operation}`, attributes, async (span) => {
      const started = clock.now();
      let attempts = 0;
      try {
        await limiter.take();
        const outcome = await breaker.execute(operation, () =>
          retryWithJitter(
            (attempt) => {
              attempts = attempt;
              return fn(attempt);
            },
            options.policy.retry,
            clock,
          ),
        );
        span.setAttribute('lance.attempts', outcome.attempts);
        await options.events?.onCall?.({
          connector: options.name,
          operation,
          kind,
          ok: true,
          status: undefined,
          attempts: outcome.attempts,
          durationMs: clock.now() - started,
        });
        return outcome.value;
      } catch (error) {
        const status = statusOf(error);
        if (status !== undefined) span.setAttribute('http.response.status_code', status);
        await options.events?.onCall?.({
          connector: options.name,
          operation,
          kind,
          ok: false,
          status,
          attempts: Math.max(attempts, 1),
          durationMs: clock.now() - started,
        });
        throw error;
      }
    });
  };

  return {
    name: options.name,
    read: (operation, context, fn) => call('read', operation, context, fn),
    write: (operation, context, fn) => call('write', operation, context, fn),
    breakerState: () => breaker.state(),
    resetBreaker: () => breaker.reset(),
    availableTokens: () => limiter.available(),
  };
}
