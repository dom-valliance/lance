import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  formatLongDate,
  isWeekend,
  isWithinQuietHours,
  nowIso,
  toLondon,
} from './time.js';

describe('nowIso', () => {
  it('returns a parseable ISO instant close to now', () => {
    const before = Date.now();
    const iso = nowIso();
    const after = Date.now();
    const parsed = new Date(iso).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('toLondon', () => {
  it('renders a winter instant in GMT', () => {
    expect(toLondon('2026-01-15T19:00:00Z')).toContain('19:00');
  });

  it('renders a summer instant shifted for BST', () => {
    // 18:00 UTC in July is 19:00 local under British Summer Time.
    expect(toLondon('2026-07-15T18:00:00Z')).toContain('19:00');
  });
});

describe('isWithinQuietHours', () => {
  const timeZone = 'Europe/London';

  it('treats the start minute as quiet (inclusive)', () => {
    expect(isWithinQuietHours('2026-01-15T19:00:00Z', '19:00', '07:00', timeZone)).toBe(true);
  });

  it('treats the minute before end as quiet', () => {
    expect(isWithinQuietHours('2026-01-15T06:59:00Z', '19:00', '07:00', timeZone)).toBe(true);
  });

  it('treats the end minute as not quiet (exclusive)', () => {
    expect(isWithinQuietHours('2026-01-15T07:00:00Z', '19:00', '07:00', timeZone)).toBe(false);
  });

  it('treats the minute before start as not quiet', () => {
    expect(isWithinQuietHours('2026-01-15T18:59:00Z', '19:00', '07:00', timeZone)).toBe(false);
  });

  it('handles the middle of the overnight window', () => {
    expect(isWithinQuietHours('2026-01-15T23:30:00Z', '19:00', '07:00', timeZone)).toBe(true);
  });

  it('handles a same-day window that does not cross midnight', () => {
    expect(isWithinQuietHours('2026-01-15T12:00:00Z', '09:00', '17:00', timeZone)).toBe(true);
    expect(isWithinQuietHours('2026-01-15T08:00:00Z', '09:00', '17:00', timeZone)).toBe(false);
    expect(isWithinQuietHours('2026-01-15T17:00:00Z', '09:00', '17:00', timeZone)).toBe(false);
  });
});

describe('isWeekend', () => {
  it('is true on the Sunday either side of the 2026 British DST change', () => {
    // Clocks go forward at 01:00 UTC on 2026-03-29; 10:00 UTC that day is
    // already BST (11:00 local), and the day is still Sunday.
    expect(isWeekend('2026-03-29T10:00:00Z', 'Europe/London')).toBe(true);
  });

  it('is false on the Monday after the 2026 British DST change', () => {
    expect(isWeekend('2026-03-30T10:00:00Z', 'Europe/London')).toBe(false);
  });

  it('is false on a midweek day', () => {
    expect(isWeekend('2026-01-14T12:00:00Z', 'Europe/London')).toBe(false);
  });
});

describe('addWorkingDays', () => {
  const london = 'Europe/London';

  it('lands on the next Monday at London midnight five working days after a Monday', () => {
    // Monday 28 September 2026, 10:00 BST.
    const opens = addWorkingDays(new Date('2026-09-28T09:00:00Z'), 5, london);
    // Monday 5 October 2026 00:00 BST is 23:00 UTC the day before.
    expect(opens.toISOString()).toBe('2026-10-04T23:00:00.000Z');
  });

  it('skips the weekend when counting from a Friday', () => {
    const opens = addWorkingDays(new Date('2026-10-02T15:00:00Z'), 5, london);
    expect(opens.toISOString()).toBe('2026-10-08T23:00:00.000Z');
  });

  it('counts a Saturday as the day before the first working day', () => {
    const opens = addWorkingDays(new Date('2026-10-03T12:00:00Z'), 5, london);
    expect(formatLongDate(opens, london)).toBe('Friday 9 October 2026');
  });

  it('uses the London date, not the UTC one, late in the evening', () => {
    // 23:30 BST on Friday 2 October is still Friday in London.
    const opens = addWorkingDays(new Date('2026-10-02T22:30:00Z'), 1, london);
    expect(formatLongDate(opens, london)).toBe('Monday 5 October 2026');
  });

  it('lands on GMT midnight after the clocks go back', () => {
    // Monday 19 October 2026; the clocks go back on Sunday 25 October.
    const opens = addWorkingDays(new Date('2026-10-19T09:00:00Z'), 5, london);
    expect(opens.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});

describe('formatLongDate', () => {
  it('names the weekday, day, month and year without a comma', () => {
    expect(formatLongDate(new Date('2026-10-05T09:00:00Z'), 'Europe/London')).toBe(
      'Monday 5 October 2026',
    );
  });
});
