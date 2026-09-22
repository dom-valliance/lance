import { describe, expect, it } from 'vitest';
import { isQuiet, nextQuietEnd } from './hours.js';

const hours = { quietHoursStart: '19:00', quietHoursEnd: '07:00' };
const zone = 'Europe/London';

describe('isQuiet', () => {
  it('is quiet overnight, at the weekend and loud on a weekday afternoon', () => {
    expect(isQuiet('2026-09-22T20:30:00.000Z', zone, hours)).toBe(true); // 21:30 BST Tuesday
    expect(isQuiet('2026-09-22T05:30:00.000Z', zone, hours)).toBe(true); // 06:30 BST Tuesday
    expect(isQuiet('2026-09-22T13:00:00.000Z', zone, hours)).toBe(false); // 14:00 BST Tuesday
    expect(isQuiet('2026-09-26T13:00:00.000Z', zone, hours)).toBe(true); // Saturday
  });

  it('treats the boundaries as quiet from the start minute and loud from the end minute', () => {
    expect(isQuiet('2026-09-22T18:00:00.000Z', zone, hours)).toBe(true); // 19:00 BST
    expect(isQuiet('2026-09-22T06:00:00.000Z', zone, hours)).toBe(false); // 07:00 BST
  });
});

describe('nextQuietEnd', () => {
  it('finds the next weekday 07:00 from a Friday evening', () => {
    expect(nextQuietEnd('2026-09-25T20:00:00.000Z', zone, hours)).toBe('2026-09-28T06:00:00.000Z');
  });
});
