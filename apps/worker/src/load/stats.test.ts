import { describe, expect, it } from 'vitest';
import { percentile, summarise } from './stats.js';

describe('percentile', () => {
  it('takes the nearest rank, whatever order the samples arrive in', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 10)).toBe(1);
  });

  it('is zero for no samples, so an idle queue reports no latency', () => {
    expect(percentile([], 95)).toBe(0);
    expect(summarise([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });
});
