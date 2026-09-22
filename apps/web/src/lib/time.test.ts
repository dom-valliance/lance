import { describe, expect, it } from 'vitest';
import {
  expiryLabel,
  formatDate,
  formatDayTitle,
  formatDuration,
  formatTime,
  relativeTo,
} from './time';

const NOW = new Date('2026-09-21T13:05:00Z');

describe('formatDate and formatTime', () => {
  it('renders the London date and time separately', () => {
    expect(formatDate(NOW)).toBe('21 Sept 2026');
    expect(formatTime(NOW)).toBe('14:05');
  });

  it('names the weekday for the Today title', () => {
    expect(formatDayTitle(NOW)).toBe('Monday 21 September');
  });

  it('describes an unparseable value instead of throwing', () => {
    expect(formatDate('not a date')).toBe('unknown date');
    expect(formatTime('not a date')).toBe('unknown time');
  });
});

describe('formatDuration', () => {
  it('picks minutes, hours or days by magnitude', () => {
    expect(formatDuration(25 * 60_000)).toBe('25 min');
    expect(formatDuration(3 * 3_600_000)).toBe('3 h');
    expect(formatDuration(2 * 86_400_000)).toBe('2 days');
    expect(formatDuration(86_400_000)).toBe('1 day');
  });

  it('rounds anything under a minute down to words', () => {
    expect(formatDuration(20_000)).toBe('under a minute');
  });
});

describe('relativeTo', () => {
  it('says "in" for a future instant and "ago" for a past one', () => {
    expect(relativeTo('2026-09-21T16:05:00Z', NOW)).toBe('in 3 h');
    expect(relativeTo('2026-09-21T11:05:00Z', NOW)).toBe('2 h ago');
  });

  it('uses yesterday and tomorrow for a single day either side', () => {
    expect(relativeTo('2026-09-20T13:05:00Z', NOW)).toBe('yesterday');
    expect(relativeTo('2026-09-22T14:00:00Z', NOW)).toBe('tomorrow');
  });

  it('says now inside a minute', () => {
    expect(relativeTo('2026-09-21T13:05:20Z', NOW)).toBe('now');
  });
});

describe('expiryLabel', () => {
  it('counts down to a deadline ahead', () => {
    expect(expiryLabel('2026-09-21T16:05:00Z', NOW)).toBe('expires in 3 h');
  });

  it('counts up from a deadline that passed', () => {
    expect(expiryLabel('2026-09-21T11:05:00Z', NOW)).toBe('expired 2 h ago');
    expect(expiryLabel('2026-09-20T13:00:00Z', NOW)).toBe('expired yesterday');
  });
});
