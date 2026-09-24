import { describe, expect, it } from 'vitest';
import { assertCron, nextOccurrences, nextRun } from './cron.js';

describe('nextOccurrences', () => {
  it('reads the expression in the given zone, honouring British Summer Time', () => {
    const [next] = nextOccurrences('30 6 * * 1-5', {
      timeZone: 'Europe/London',
      from: new Date('2026-09-24T12:00:00.000Z'),
      count: 1,
    });
    // Friday 25 September, 06:30 BST is 05:30 UTC.
    expect(next?.toISOString()).toBe('2026-09-25T05:30:00.000Z');
  });

  it('returns as many occurrences as asked for, in order', () => {
    const runs = nextOccurrences('*/15 * * * *', {
      timeZone: 'UTC',
      from: new Date('2026-09-24T12:01:00.000Z'),
      count: 3,
    });
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-09-24T12:15:00.000Z',
      '2026-09-24T12:30:00.000Z',
      '2026-09-24T12:45:00.000Z',
    ]);
  });
});

describe('nextRun', () => {
  it('picks the earliest run across several expressions', () => {
    const run = nextRun(
      ['0 * * * 0,6', '*/10 7-18 * * 1-5'],
      'Europe/London',
      new Date('2026-09-24T12:01:00.000Z'),
    );
    expect(run?.toISOString()).toBe('2026-09-24T12:10:00.000Z');
  });

  it('is null for no expressions', () => {
    expect(nextRun([], 'UTC', new Date())).toBeNull();
  });
});

describe('assertCron', () => {
  it('refuses an expression with a seconds field', () => {
    expect(() => {
      assertCron('0 30 6 * * 1-5');
    }).toThrow(/five-field/);
  });

  it('refuses an expression the parser cannot read', () => {
    expect(() => {
      assertCron('61 * * * *');
    }).toThrow(/not a valid cron expression/);
  });
});
