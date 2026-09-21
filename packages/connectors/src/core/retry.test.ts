import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from './errors.js';
import { retryWithJitter } from './retry.js';
import { FakeClock } from './testing.js';

const policy = { attempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };
const retryable = (status: number) =>
  new ConnectorError(`HTTP ${status}`, {
    connector: 'graph',
    operation: 'op',
    status,
    retryable: true,
  });
const fatal = new ConnectorError('HTTP 400', {
  connector: 'graph',
  operation: 'op',
  status: 400,
  retryable: false,
});

describe('retryWithJitter', () => {
  it('returns the first success and counts attempts', async () => {
    const fn = vi.fn().mockRejectedValueOnce(retryable(503)).mockResolvedValueOnce('ok');
    const outcome = await retryWithJitter(fn, policy, new FakeClock(), () => 0.5);
    expect(outcome).toEqual({ value: 'ok', attempts: 2 });
  });

  it('does not retry an error that says it is not retryable', async () => {
    const fn = vi.fn().mockRejectedValue(fatal);
    await expect(retryWithJitter(fn, policy, new FakeClock())).rejects.toBe(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not a ConnectorError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bug'));
    await expect(retryWithJitter(fn, policy, new FakeClock())).rejects.toThrow('bug');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts', async () => {
    const fn = vi.fn().mockRejectedValue(retryable(500));
    await expect(retryWithJitter(fn, policy, new FakeClock(), () => 0)).rejects.toThrow('HTTP 500');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('draws each delay from zero up to the capped exponential', async () => {
    const clock = new FakeClock();
    const fn = vi.fn().mockRejectedValue(retryable(500));
    await expect(retryWithJitter(fn, policy, clock, () => 0.999)).rejects.toThrow();
    expect(clock.sleeps).toEqual([99, 199, 399]);
  });

  it('obeys a caller predicate that is stricter than the error itself', async () => {
    const only429 = (error: unknown): boolean =>
      error instanceof ConnectorError && error.status === 429;
    const fn = vi.fn().mockRejectedValue(retryable(503));
    await expect(retryWithJitter(fn, policy, new FakeClock(), () => 0, only429)).rejects.toThrow(
      'HTTP 503',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries what a caller predicate allows', async () => {
    const only429 = (error: unknown): boolean =>
      error instanceof ConnectorError && error.status === 429;
    const fn = vi.fn().mockRejectedValueOnce(retryable(429)).mockResolvedValueOnce('ok');
    const outcome = await retryWithJitter(fn, policy, new FakeClock(), () => 0, only429);
    expect(outcome).toEqual({ value: 'ok', attempts: 2 });
  });

  it('honours Retry-After over the backoff, capped at the maximum delay', async () => {
    const clock = new FakeClock();
    const error = new ConnectorError('HTTP 429', {
      connector: 'graph',
      operation: 'op',
      status: 429,
      retryable: true,
      retryAfterSeconds: 5,
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
    await retryWithJitter(fn, policy, clock, () => 0.5);
    expect(clock.sleeps).toEqual([1000]);
  });
});
