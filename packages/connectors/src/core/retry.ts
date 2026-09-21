import { isConnectorError } from './errors.js';
import { systemClock, type Clock } from './rateLimit.js';

export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

/** Decides whether a failed attempt may be tried again. */
export type ShouldRetry = (error: unknown) => boolean;

/** The default: an error is retried only when it says it is retryable. */
export const retryWhenRetryable: ShouldRetry = (error) =>
  isConnectorError(error) ? error.retryable : false;

/**
 * Exponential backoff with full jitter (delay uniformly drawn from 0 to the
 * capped exponential), honouring Retry-After when the remote sends one.
 * Only errors that say they are retryable are retried; a 400 or 404 fails
 * at once. A caller that must be stricter, such as a write the remote may
 * already have committed, passes its own `shouldRetry`.
 */
export async function retryWithJitter<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  clock: Clock = systemClock,
  random: () => number = Math.random,
  shouldRetry: ShouldRetry = retryWhenRetryable,
): Promise<RetryOutcome<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry(error);
      if (!retryable || attempt === policy.attempts) throw error;
      const retryAfterMs =
        isConnectorError(error) && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : undefined;
      const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const delay = retryAfterMs ?? Math.floor(random() * exponential);
      await clock.sleep(Math.min(delay, policy.maxDelayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
