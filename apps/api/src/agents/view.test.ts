import { describe, expect, it } from 'vitest';
import { fakeAgentRun, fakeAlert, fakeCursorRow } from '../test-fakes.js';
import type { AgentRunRow } from './store.js';
import {
  COST_CHART_DAYS,
  toAgentSummaries,
  toBreakerViews,
  toCostByDay,
  toWatcherViews,
} from './view.js';

const AT = new Date('2026-09-22T08:00:00.000Z');
const TIME_ZONE = 'Europe/London';
/** Midnight at the start of 22 September 2026 in Europe/London. */
const DAY_START = new Date('2026-09-21T23:00:00.000Z');
const WEEK_START = new Date('2026-09-15T23:00:00.000Z');
const USD_TO_GBP = 0.5;

describe('toWatcherViews', () => {
  it('groups the cursor rows of one watcher into its partitions', () => {
    const watchers = toWatcherViews(
      [
        fakeCursorRow({ key: 'sentitems', updatedAt: new Date('2026-09-22T07:50:00.000Z') }),
        fakeCursorRow({ key: 'inbox', updatedAt: new Date('2026-09-22T07:55:00.000Z') }),
      ],
      AT,
    );

    expect(watchers).toHaveLength(1);
    expect(watchers[0]?.partitions.map((partition) => partition.key)).toEqual([
      'inbox',
      'sentitems',
    ]);
  });

  it('reads the start marker as the watcher start, not as a partition', () => {
    const watchers = toWatcherViews(
      [
        fakeCursorRow({ key: '__started_at', value: '2026-09-01T06:00:00.000Z' }),
        fakeCursorRow({ key: 'inbox' }),
      ],
      AT,
    );

    expect(watchers[0]?.startedAt).toBe('2026-09-01T06:00:00.000Z');
    expect(watchers[0]?.partitions.map((partition) => partition.key)).toEqual(['inbox']);
  });

  it('ages each partition in whole minutes', () => {
    const watchers = toWatcherViews(
      [fakeCursorRow({ updatedAt: new Date('2026-09-22T07:48:30.000Z') })],
      AT,
    );

    expect(watchers[0]?.partitions[0]?.ageMinutes).toBe(11);
  });

  it('takes the freshest partition as the last run', () => {
    const watchers = toWatcherViews(
      [
        fakeCursorRow({ key: 'inbox', updatedAt: new Date('2026-09-22T06:00:00.000Z') }),
        fakeCursorRow({ key: 'sentitems', updatedAt: new Date('2026-09-22T07:50:00.000Z') }),
      ],
      AT,
    );

    expect(watchers[0]?.lastRunAgeMinutes).toBe(10);
  });

  it('reports no last run for a watcher that has started and never polled', () => {
    const watchers = toWatcherViews(
      [fakeCursorRow({ key: '__started_at', value: '2026-09-22T06:00:00.000Z' })],
      AT,
    );

    expect(watchers[0]?.lastRunAgeMinutes).toBeNull();
    expect(watchers[0]?.partitions).toEqual([]);
  });

  it('orders watchers by name', () => {
    const watchers = toWatcherViews(
      [fakeCursorRow({ watcher: 'notion' }), fakeCursorRow({ watcher: 'graph-calendar' })],
      AT,
    );

    expect(watchers.map((watcher) => watcher.name)).toEqual(['graph-calendar', 'notion']);
  });
});

describe('toAgentSummaries', () => {
  const summaries = (runs: AgentRunRow[]): ReturnType<typeof toAgentSummaries> =>
    toAgentSummaries({
      runs,
      lastRuns: [{ agent: 'triage', startedAt: new Date('2026-09-22T07:00:00.000Z'), error: null }],
      dayStart: DAY_START,
      weekStart: WEEK_START,
      usdToGbp: USD_TO_GBP,
    });

  it('counts a run started today against both today and the week', () => {
    const rows = summaries([
      fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z') }),
      fakeAgentRun({ startedAt: new Date('2026-09-19T07:00:00.000Z') }),
    ]);

    expect(rows[0]?.runsToday).toBe(1);
    expect(rows[0]?.runs7Days).toBe(2);
  });

  it('counts a failed run today as a failure', () => {
    const rows = summaries([
      fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z'), status: 'failed' }),
      fakeAgentRun({ startedAt: new Date('2026-09-22T07:30:00.000Z') }),
    ]);

    expect(rows[0]?.failuresToday).toBe(1);
  });

  it('converts every cost to pounds', () => {
    const rows = summaries([
      fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z'), costUsd: 0.2 }),
      fakeAgentRun({ startedAt: new Date('2026-09-18T07:00:00.000Z'), costUsd: 0.4 }),
    ]);

    expect(rows[0]?.costTodayGbp).toBe(0.1);
    expect(rows[0]?.cost7DaysGbp).toBe(0.3);
  });

  it('carries the last run and the error it ended with', () => {
    const rows = toAgentSummaries({
      runs: [],
      lastRuns: [
        {
          agent: 'planner',
          startedAt: new Date('2026-09-01T05:30:00.000Z'),
          error: 'overloaded_error',
        },
      ],
      dayStart: DAY_START,
      weekStart: WEEK_START,
      usdToGbp: USD_TO_GBP,
    });

    expect(rows[0]).toMatchObject({
      name: 'planner',
      lastRunAt: '2026-09-01T05:30:00.000Z',
      lastError: 'overloaded_error',
      runsToday: 0,
      runs7Days: 0,
    });
  });

  it('orders agents by name', () => {
    const rows = toAgentSummaries({
      runs: [fakeAgentRun({ agent: 'watcher-labels' }), fakeAgentRun({ agent: 'critic' })],
      lastRuns: [],
      dayStart: DAY_START,
      weekStart: WEEK_START,
      usdToGbp: USD_TO_GBP,
    });

    expect(rows.map((row) => row.name)).toEqual(['critic', 'watcher-labels']);
  });
});

describe('toCostByDay', () => {
  it('returns a fortnight of local days, oldest first', () => {
    const days = toCostByDay([], AT, TIME_ZONE, USD_TO_GBP);

    expect(days).toHaveLength(COST_CHART_DAYS);
    expect(days[0]?.date).toBe('2026-09-09');
    expect(days.at(-1)?.date).toBe('2026-09-22');
  });

  it('fills a day with no runs with zero rather than leaving a gap', () => {
    const days = toCostByDay(
      [fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z'), costUsd: 0.2 })],
      AT,
      TIME_ZONE,
      USD_TO_GBP,
    );

    expect(days.filter((day) => day.gbp === 0)).toHaveLength(COST_CHART_DAYS - 1);
    expect(days.at(-1)?.gbp).toBe(0.1);
  });

  it('buckets a run by its local day, not by its UTC day', () => {
    // 00:30 on 22 September in Europe/London is 23:30 on the 21st in UTC.
    const days = toCostByDay(
      [fakeAgentRun({ startedAt: new Date('2026-09-21T23:30:00.000Z'), costUsd: 1 })],
      AT,
      TIME_ZONE,
      USD_TO_GBP,
    );

    expect(days.find((day) => day.date === '2026-09-22')?.gbp).toBe(0.5);
    expect(days.find((day) => day.date === '2026-09-21')?.gbp).toBe(0);
  });

  it('adds up the runs of one day', () => {
    const days = toCostByDay(
      [
        fakeAgentRun({ startedAt: new Date('2026-09-22T06:00:00.000Z'), costUsd: 0.2 }),
        fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z'), costUsd: 0.2 }),
      ],
      AT,
      TIME_ZONE,
      USD_TO_GBP,
    );

    expect(days.at(-1)?.gbp).toBe(0.2);
  });
});

describe('toBreakerViews', () => {
  it('names the connector from the alert dedupe key', () => {
    const breakers = toBreakerViews([fakeAlert({ dedupeKey: 'breaker:graph' })]);

    expect(breakers).toEqual([{ connector: 'graph', state: 'open', openUntil: null }]);
  });

  it('ignores an alert whose dedupe key is not a breaker', () => {
    expect(toBreakerViews([fakeAlert({ dedupeKey: 'thread:AAMk3' })])).toEqual([]);
  });

  it('reports one connector once however many alerts it has raised', () => {
    const breakers = toBreakerViews([
      fakeAlert({ id: '01K5S9V6QW3SWCCPVB0N0E304A', dedupeKey: 'breaker:notion' }),
      fakeAlert({ id: '01K5S9V6QW3SWCCPVB0N0E304B', dedupeKey: 'breaker:notion' }),
    ]);

    expect(breakers).toHaveLength(1);
  });
});
