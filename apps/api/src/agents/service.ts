import { nowIso } from '@lance/shared';
import type { ApiDeps } from '../deps.js';
import { shiftLocalDays, startOfLocalDay } from '../status.js';
import {
  COST_CHART_DAYS,
  COST_WINDOW_DAYS,
  roundGbp,
  toAgentSummaries,
  toBreakerViews,
  toCostByDay,
  toWatcherViews,
  type AgentsStatus,
} from './view.js';

/**
 * The Agents page's one read (spec 12, Agents row, and spec 13). Everything
 * is computed in `config.timeZone`, so "today" and each bar of the cost
 * chart mean the same local day here as they do in the morning brief, and
 * every USD cost is converted once with `config.cost.usdToGbp`.
 */

export type AgentsDeps = Pick<ApiDeps, 'agents' | 'alerts' | 'control' | 'config' | 'now'>;

const HOUR_MS = 60 * 60 * 1000;

/** Enough open breakers for every connector Lance has, several times over. */
const OPEN_BREAKER_LIMIT = 100;

export async function agentsStatus(deps: AgentsDeps): Promise<AgentsStatus> {
  const at = new Date((deps.now ?? nowIso)());
  const timeZone = deps.config.timeZone;
  const dayStart = startOfLocalDay(at, timeZone);
  const weekStart = shiftLocalDays(at, -(COST_WINDOW_DAYS - 1), timeZone);
  const chartStart = shiftLocalDays(at, -(COST_CHART_DAYS - 1), timeZone);

  const [state, cursorRows, runs, lastRuns, pushesLastHour, breakerAlerts] = await Promise.all([
    deps.control.read(),
    deps.agents.listCursors(),
    deps.agents.runsSince(chartStart),
    deps.agents.lastRuns(),
    deps.agents.pushesSince(new Date(at.getTime() - HOUR_MS)),
    deps.alerts.list({ status: 'open', kind: 'breaker_open', limit: OPEN_BREAKER_LIMIT }),
  ]);

  const usdToGbp = deps.config.cost.usdToGbp;
  const ceilingGbp = deps.config.cost.dailyCeilingGbp;
  const costTodayGbp = roundGbp(
    runs
      .filter((run) => run.startedAt >= dayStart)
      .reduce((total, run) => total + run.costUsd * usdToGbp, 0),
  );

  return {
    system: { paused: state.paused, pausedReason: state.pausedReason, mode: state.mode },
    watchers: toWatcherViews(cursorRows, at),
    agents: toAgentSummaries({ runs, lastRuns, dayStart, weekStart, usdToGbp }),
    costToday: {
      gbp: costTodayGbp,
      ceilingGbp,
      fraction: ceilingGbp === 0 ? 0 : roundGbp(costTodayGbp / ceilingGbp),
    },
    costByDay: toCostByDay(runs, at, timeZone, usdToGbp),
    pushesLastHour,
    breakers: toBreakerViews(breakerAlerts),
  };
}
