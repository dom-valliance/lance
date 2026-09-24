import { describe, expect, it } from 'vitest';
import { dueBetween, nextMondayAt, virtualClock } from './cron.js';

describe('the virtual clock', () => {
  it('finds the next Monday 06:30 in London, in summer time', () => {
    const opening = nextMondayAt('06:30', 'Europe/London', new Date('2026-09-24T14:00:00Z'));
    expect(opening.toISOString()).toBe('2026-09-28T05:30:00.000Z');
  });

  it('maps real time onto virtual time and back by a fixed offset', () => {
    let real = 1_000_000;
    const clock = virtualClock(new Date('2026-09-28T05:29:00Z'), real, () => real);
    real += 60_000;
    expect(new Date(clock.now()).toISOString()).toBe('2026-09-28T05:30:00.000Z');
    expect(clock.realOf(new Date('2026-09-28T05:30:00Z'))).toBe(real);
  });
});

describe('dueBetween', () => {
  const schedules = [
    { name: 'brief-morning', key: 'a', cron: '30 6 * * 1-5', timezone: 'Europe/London' },
    { name: 'alerts-deliver', key: 'b', cron: '* * * * *', timezone: 'Europe/London' },
    {
      name: 'watcher-graph-mail',
      key: 'c',
      cron: '0 0-6,19-23 * * 1-5',
      timezone: 'Europe/London',
    },
  ];

  it('fires the morning brief at 06:30 London and not the 06:00 mail poll already past', () => {
    const due = dueBetween(
      schedules,
      new Date('2026-09-28T05:29:30Z'),
      new Date('2026-09-28T05:30:30Z'),
    );
    expect(due.map((job) => job.schedule.name).sort()).toEqual(['alerts-deliver', 'brief-morning']);
  });

  it('fires nothing twice across consecutive ticks', () => {
    const ticks = [0, 20, 40, 60, 80, 100, 120].map(
      (s) => new Date(Date.parse('2026-09-28T05:29:00Z') + s * 1000),
    );
    const fired = ticks
      .slice(1)
      .flatMap((to, index) => dueBetween(schedules, ticks[index] ?? to, to))
      .map((job) => `${job.schedule.name}@${job.at.toISOString()}`)
      .sort();
    expect(fired).toEqual([
      'alerts-deliver@2026-09-28T05:30:00.000Z',
      'alerts-deliver@2026-09-28T05:31:00.000Z',
      'brief-morning@2026-09-28T05:30:00.000Z',
    ]);
  });
});
