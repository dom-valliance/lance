import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from './breaker.js';
import { CircuitOpenError } from './errors.js';
import { FakeClock } from './testing.js';

const policy = { failureThreshold: 3, halfOpenAfterMs: 60_000 };
const boom = new Error('remote down');

describe('CircuitBreaker', () => {
  it('stays closed while failures are below the threshold', async () => {
    const breaker = new CircuitBreaker('graph', policy, {}, new FakeClock());
    await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    expect(breaker.state()).toBe('closed');
    expect(breaker.consecutiveFailures()).toBe(2);
  });

  it('opens on the third consecutive failure and raises the open event once', async () => {
    const onOpen = vi.fn();
    const breaker = new CircuitBreaker('graph', policy, { onOpen }, new FakeClock());
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    }
    expect(breaker.state()).toBe('open');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('graph', boom);
  });

  it('refuses calls without touching the remote while open', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('graph', policy, {}, clock);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    }
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(breaker.execute('op', fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows one probe after the timeout and closes on success', async () => {
    const clock = new FakeClock();
    const onClose = vi.fn();
    const breaker = new CircuitBreaker('graph', policy, { onClose }, clock);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    }
    clock.advance(60_000);
    expect(breaker.state()).toBe('half_open');
    await expect(breaker.execute('op', () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.state()).toBe('closed');
    expect(onClose).toHaveBeenCalledWith('graph');
  });

  it('reopens without a second open event when the probe fails', async () => {
    const clock = new FakeClock();
    const onOpen = vi.fn();
    const breaker = new CircuitBreaker('graph', policy, { onOpen }, clock);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    }
    clock.advance(60_000);
    await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    expect(breaker.state()).toBe('open');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('resets on demand', async () => {
    const breaker = new CircuitBreaker('graph', policy, {}, new FakeClock());
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', () => Promise.reject(boom))).rejects.toBe(boom);
    }
    breaker.reset();
    expect(breaker.state()).toBe('closed');
    await expect(breaker.execute('op', () => Promise.resolve(1))).resolves.toBe(1);
  });
});
