import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FairShareLimiter } from './limiter.js';

/** A run that finishes when the test says so, recording when it started. */
interface Gate {
  started: string[];
  release: Map<string, () => void>;
  work: (label: string) => () => Promise<string>;
}

const gate = (): Gate => {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  return {
    started,
    release,
    work: (label) => () =>
      new Promise<string>((resolve) => {
        started.push(label);
        release.set(label, () => {
          resolve(label);
        });
      }),
  };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let clock = 0;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FairShareLimiter', () => {
  it('never has more runs in flight than the concurrency cap', async () => {
    const limiter = new FairShareLimiter({
      concurrency: 2,
      burst: 10,
      refillPerMinute: 60,
      now: () => clock,
    });
    const runs = gate();
    const done = ['a1', 'a2', 'a3'].map((label) => limiter.run('A', runs.work(label)));
    await settle();
    expect(runs.started).toEqual(['a1', 'a2']);
    runs.release.get('a1')?.();
    await settle();
    expect(runs.started).toEqual(['a1', 'a2', 'a3']);
    runs.release.get('a2')?.();
    runs.release.get('a3')?.();
    expect(await Promise.all(done)).toEqual(['a1', 'a2', 'a3']);
  });

  it("gives a second principal the next slot rather than queueing it behind the first one's backlog", async () => {
    const limiter = new FairShareLimiter({
      concurrency: 1,
      burst: 20,
      refillPerMinute: 60,
      now: () => clock,
    });
    const runs = gate();
    const backlog = Array.from({ length: 10 }, (_, index) =>
      limiter.run('backfill', runs.work(`backfill-${String(index)}`)),
    );
    await settle();
    const brief = limiter.run('morning', runs.work('brief'));
    await settle();
    runs.release.get('backfill-0')?.();
    await settle();
    expect(runs.started).toEqual(['backfill-0', 'brief']);
    runs.release.get('brief')?.();
    expect(await brief).toBe('brief');
    for (let index = 1; index < 10; index += 1) {
      await settle();
      runs.release.get(`backfill-${String(index)}`)?.();
    }
    await Promise.all(backlog);
  });

  it('holds a principal to their bucket and admits the next run once a token has refilled', async () => {
    const limiter = new FairShareLimiter({
      concurrency: 5,
      burst: 2,
      refillPerMinute: 60,
      now: () => clock,
    });
    const runs = gate();
    const all = ['a1', 'a2', 'a3'].map((label) => limiter.run('A', runs.work(label)));
    await settle();
    expect(runs.started).toEqual(['a1', 'a2']);
    expect(limiter.snapshot()).toEqual({ active: 2, waiting: { A: 1 } });
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(runs.started).toEqual(['a1', 'a2', 'a3']);
    for (const label of ['a1', 'a2', 'a3']) runs.release.get(label)?.();
    await Promise.all(all);
  });

  it("does not let one principal's empty bucket hold up another principal", async () => {
    const limiter = new FairShareLimiter({
      concurrency: 5,
      burst: 1,
      refillPerMinute: 1,
      now: () => clock,
    });
    const runs = gate();
    const a = [limiter.run('A', runs.work('a1')), limiter.run('A', runs.work('a2'))];
    const b = limiter.run('B', runs.work('b1'));
    await settle();
    expect(runs.started).toEqual(['a1', 'b1']);
    runs.release.get('a1')?.();
    runs.release.get('b1')?.();
    await b;
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(runs.started).toEqual(['a1', 'b1', 'a2']);
    runs.release.get('a2')?.();
    await Promise.all(a);
  });

  it('frees the slot when a run throws', async () => {
    const limiter = new FairShareLimiter({
      concurrency: 1,
      burst: 5,
      refillPerMinute: 60,
      now: () => clock,
    });
    await expect(
      limiter.run('A', () => Promise.reject(new Error('model refused'))),
    ).rejects.toThrow('model refused');
    expect(await limiter.run('A', () => Promise.resolve('next'))).toBe('next');
  });

  it('refuses a configuration that could never admit a run', () => {
    expect(() => new FairShareLimiter({ concurrency: 0, burst: 1, refillPerMinute: 1 })).toThrow(
      /MODEL_CONCURRENCY/,
    );
  });
});
