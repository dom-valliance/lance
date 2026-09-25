import { describe, expect, it } from 'vitest';
import { nextRunOf } from './service.js';

describe('nextRunOf', () => {
  const from = new Date('2026-09-24T12:01:00.000Z');

  it('takes the earliest run across a job with several schedules, in their own zone', () => {
    const next = nextRunOf(
      [
        { slug: 'watcher-graph-mail', cron: '*/10 7-18 * * 1-5', timeZone: 'Europe/London' },
        { slug: 'watcher-graph-mail', cron: '0 * * * 0,6', timeZone: 'Europe/London' },
        { slug: 'brief-morning', cron: '30 6 * * 1-5', timeZone: 'Europe/London' },
      ],
      'watcher-graph-mail',
      from,
    );
    expect(next).toBe('2026-09-24T12:10:00.000Z');
  });

  it('is null for a job with no schedule, such as a paused one', () => {
    expect(nextRunOf([], 'brief-morning', from)).toBeNull();
  });
});
