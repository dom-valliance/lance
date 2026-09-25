import { describe, expect, it } from 'vitest';
import { seededRandom } from './random.js';

describe('seededRandom', () => {
  it('draws the same sequence from the same seed, so two runs are comparable', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const draws = (random: typeof a) =>
      Array.from({ length: 20 }, () => random.between(3000, 8000));
    expect(draws(a)).toEqual(draws(b));
  });

  it('keeps every draw inside the inclusive range', () => {
    const random = seededRandom(7);
    const draws = Array.from({ length: 5000 }, () => random.between(3000, 8000));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(3000);
    expect(Math.max(...draws)).toBeLessThanOrEqual(8000);
    expect(new Set(draws).size).toBeGreaterThan(1000);
  });
});
