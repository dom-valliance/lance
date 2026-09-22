import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeAgentRun,
  fakeAlert,
  fakeCursorRow,
  fakeDeps,
  testConfig,
  type FakeDeps,
} from '../test-fakes.js';
import { agentsStatus } from './service.js';

/** The Agents page's one read, over the fake stores. */

/** 09:00 on 22 September 2026 in Europe/London, which is BST. */
const NOW = '2026-09-22T08:00:00.000Z';

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps({
    now: () => NOW,
    config: testConfig({ COST_USD_TO_GBP: '0.5', COST_DAILY_CEILING_GBP: '10' }),
  });
  harness.agents.cursorRows = [
    fakeCursorRow({ key: '__started_at', value: '2026-09-01T06:00:00.000Z' }),
    fakeCursorRow({ key: 'inbox', updatedAt: new Date('2026-09-22T07:50:00.000Z') }),
  ];
  harness.agents.runs = [
    fakeAgentRun({ startedAt: new Date('2026-09-22T07:00:00.000Z'), costUsd: 0.2 }),
    fakeAgentRun({ startedAt: new Date('2026-09-18T07:00:00.000Z'), costUsd: 0.4 }),
  ];
  harness.alerts.rows = [];
});

describe('agentsStatus', () => {
  it('reports whether Lance is paused, why, and the mode it is in', async () => {
    harness.control.state = { ...harness.control.state, paused: true, pausedReason: 'rotating' };

    const status = await agentsStatus(harness.deps);

    expect(status.system).toEqual({ paused: true, pausedReason: 'rotating', mode: 'dry_run' });
  });

  it('groups the cursors into watchers with their partitions', async () => {
    const status = await agentsStatus(harness.deps);

    expect(status.watchers).toHaveLength(1);
    expect(status.watchers[0]?.startedAt).toBe('2026-09-01T06:00:00.000Z');
    expect(status.watchers[0]?.partitions.map((partition) => partition.key)).toEqual(['inbox']);
    expect(status.watchers[0]?.lastRunAgeMinutes).toBe(10);
  });

  it('summarises each agent from its runs', async () => {
    const status = await agentsStatus(harness.deps);

    expect(status.agents[0]).toMatchObject({
      name: 'triage',
      runsToday: 1,
      runs7Days: 2,
      failuresToday: 0,
      costTodayGbp: 0.1,
      cost7DaysGbp: 0.3,
      lastRunAt: '2026-09-22T07:00:00.000Z',
      lastError: null,
    });
  });

  it('measures today against the daily ceiling', async () => {
    const status = await agentsStatus(harness.deps);

    expect(status.costToday).toEqual({ gbp: 0.1, ceilingGbp: 10, fraction: 0.01 });
  });

  it('charts a fortnight of local days, oldest first', async () => {
    const status = await agentsStatus(harness.deps);

    expect(status.costByDay).toHaveLength(14);
    expect(status.costByDay[0]?.date).toBe('2026-09-09');
    expect(status.costByDay.at(-1)).toEqual({ date: '2026-09-22', gbp: 0.1 });
  });

  it('counts the pushes of the last hour', async () => {
    harness.agents.pushes = 2;

    const status = await agentsStatus(harness.deps);

    expect(status.pushesLastHour).toBe(2);
    expect(harness.agents.pushWindows[0]?.toISOString()).toBe('2026-09-22T07:00:00.000Z');
  });

  it('reports a connector whose breaker alert is still open', async () => {
    harness.alerts.rows = [fakeAlert({ kind: 'breaker_open', dedupeKey: 'breaker:notion' })];

    const status = await agentsStatus(harness.deps);

    expect(status.breakers).toEqual([{ connector: 'notion', state: 'open', openUntil: null }]);
  });

  it('asks only for open breaker alerts, so an acked one is not an open breaker', async () => {
    await agentsStatus(harness.deps);

    expect(harness.alerts.queries[0]).toMatchObject({ status: 'open', kind: 'breaker_open' });
  });
});
