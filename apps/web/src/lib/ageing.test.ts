import { describe, expect, it } from 'vitest';
import { ageingEmphasis, dueLabel, londonDay } from './ageing';

const NOW = new Date('2026-09-21T13:05:00Z');

describe('londonDay', () => {
  it('reads the calendar day in London, not UTC', () => {
    expect(londonDay(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });
});

describe('dueLabel', () => {
  it('says overdue with the day count for a past date', () => {
    expect(dueLabel('2026-09-19', NOW)).toEqual({ label: 'overdue by 2 days', emphasis: 'overdue' });
  });

  it('says due today with the soon emphasis', () => {
    expect(dueLabel('2026-09-21', NOW)).toEqual({ label: 'due today', emphasis: 'soon' });
  });

  it('counts forward for a future date', () => {
    expect(dueLabel('2026-09-22', NOW)).toEqual({ label: 'due tomorrow', emphasis: 'none' });
    expect(dueLabel('2026-09-25', NOW)).toEqual({ label: 'due in 4 days', emphasis: 'none' });
  });

  it('says no date when there is none', () => {
    expect(dueLabel(null, NOW)).toEqual({ label: 'no date', emphasis: 'none' });
  });
});

describe('ageingEmphasis', () => {
  it('flags an overdue commitment label', () => {
    expect(ageingEmphasis('overdue by 3 days')).toBe('overdue');
  });

  it('flags due today as soon and everything else as plain', () => {
    expect(ageingEmphasis('due today')).toBe('soon');
    expect(ageingEmphasis('due in 3 days')).toBe('none');
    expect(ageingEmphasis('done yesterday')).toBe('none');
  });
});
