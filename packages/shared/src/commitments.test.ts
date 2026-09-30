import { describe, expect, it } from 'vitest';
import { dueAtFromDay, firstChaseAt } from './commitments.js';

describe('dueAtFromDay', () => {
  it('reads a winter day as 17:00 GMT', () => {
    expect(dueAtFromDay('2026-12-04', 'Europe/London').toISOString()).toBe(
      '2026-12-04T17:00:00.000Z',
    );
  });

  it('reads a summer day as 17:00 BST, an hour earlier in UTC', () => {
    expect(dueAtFromDay('2026-09-30', 'Europe/London').toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
  });

  it('refuses a value that is not a day', () => {
    expect(() => dueAtFromDay('30/09/2026', 'Europe/London')).toThrow(/YYYY-MM-DD/);
  });

  it('refuses a day the calendar does not have', () => {
    expect(() => dueAtFromDay('2026-02-30', 'Europe/London')).toThrow(/not a calendar day/);
  });
});

describe('firstChaseAt', () => {
  it('chases two days after the due date', () => {
    expect(firstChaseAt(new Date('2026-09-18T17:00:00.000Z')).toISOString()).toBe(
      '2026-09-20T17:00:00.000Z',
    );
  });
});
