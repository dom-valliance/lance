import { describe, expect, it } from 'vitest';
import { renderStatus, startOfLocalDay } from './status.js';
import { fakeSnapshot } from './test-fakes.js';

describe('renderStatus', () => {
  it('reports that Lance is running when it is not paused', () => {
    const text = renderStatus(fakeSnapshot(), 'Lance');

    expect(text.split('\n')[0]).toBe('Lance status');
    expect(text).toContain('Paused: no.');
  });

  it('reports the reason, the actor and when the pause began', () => {
    const text = renderStatus(
      fakeSnapshot({
        paused: true,
        pausedReason: 'rotating the Graph refresh token',
        pausedBy: 'user:dom',
        pausedAt: '2026-07-01T08:30:00.000Z',
      }),
      'Lance',
    );

    expect(text).toContain(
      'Paused: yes. Reason: rotating the Graph refresh token. By: user:dom. Since: 1 Jul 2026, 09:30.',
    );
  });

  it('displays the pause time in Europe/London, not UTC', () => {
    const winter = renderStatus(
      fakeSnapshot({ paused: true, pausedAt: '2026-01-15T08:30:00.000Z' }),
      'Lance',
    );

    expect(winter).toContain('Since: 15 Jan 2026, 08:30.');
  });

  it('names the mode', () => {
    expect(renderStatus(fakeSnapshot({ mode: 'live' }), 'Lance')).toContain('Mode: live.');
  });

  it('lists each watcher cursor with its age', () => {
    const text = renderStatus(
      fakeSnapshot({
        cursors: [
          {
            watcher: 'graph-mail',
            key: 'inbox',
            value: 'delta',
            updatedAt: '2026-09-20T08:48:00.000Z',
            ageMinutes: 12,
          },
          {
            watcher: 'jamie',
            key: 'meetings',
            value: '2026-09-20',
            updatedAt: '2026-09-20T06:00:00.000Z',
            ageMinutes: 180,
          },
        ],
      }),
      'Lance',
    );

    expect(text).toContain('  graph-mail (inbox): updated 12 minutes ago.');
    expect(text).toContain('  jamie (meetings): updated 3 hours ago.');
  });

  it('says so when no cursor has been written yet', () => {
    expect(renderStatus(fakeSnapshot({ cursors: [] }), 'Lance')).toContain(
      'Watchers: no cursors recorded yet.',
    );
  });

  it('rounds today cost to two decimal places in pounds', () => {
    expect(renderStatus(fakeSnapshot({ costTodayGbp: 1.2349 }), 'Lance')).toContain(
      'Cost today: GBP 1.23.',
    );
  });

  it('uses the configured display name', () => {
    expect(renderStatus(fakeSnapshot(), 'Ian').split('\n')[0]).toBe('Ian status');
  });

  it('contains no emoji and no em dash', () => {
    const text = renderStatus(
      fakeSnapshot({ paused: true, pausedReason: 'a reason', pausedBy: 'user:dom' }),
      'Lance',
    );

    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // \u2014 is the em dash: banned in every string Lance shows a human.
    expect(text).not.toMatch(/\u2014/);
  });
});

describe('startOfLocalDay', () => {
  it('starts a British Summer Time day at 23:00 UTC the evening before', () => {
    const start = startOfLocalDay(new Date('2026-09-20T09:00:00.000Z'), 'Europe/London');
    expect(start.toISOString()).toBe('2026-09-19T23:00:00.000Z');
  });

  it('starts a Greenwich Mean Time day at midnight UTC', () => {
    const start = startOfLocalDay(new Date('2026-01-15T09:00:00.000Z'), 'Europe/London');
    expect(start.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('starts the day the clocks go forward at 23:00 UTC the evening before', () => {
    const start = startOfLocalDay(new Date('2026-03-29T12:00:00.000Z'), 'Europe/London');
    expect(start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });

  it('handles an instant that is already the local midnight', () => {
    const start = startOfLocalDay(new Date('2026-09-19T23:00:00.000Z'), 'Europe/London');
    expect(start.toISOString()).toBe('2026-09-19T23:00:00.000Z');
  });
});
