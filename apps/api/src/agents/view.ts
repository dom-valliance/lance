import type { Alert } from '@lance/db';
import type { SystemMode } from '@lance/shared';
import { ageMinutesBetween, localDateOf, shiftLocalDays } from '../status.js';
import type { AgentLastRun, AgentRunRow, CursorRow } from './store.js';

/**
 * The shape the Agents page renders (spec 12, Agents row, and spec 13):
 * every watcher with its cursors and their ages, every agent with its runs,
 * failures and cost, the day's spend against the ceiling, the fortnight's
 * cost chart, the interruption pushes in the last hour, and any connector
 * whose breaker is open. Dates leave the api as ISO strings.
 */

/** The cursors key the watcher runner writes once, when a watcher first runs. */
export const STARTED_AT_KEY = '__started_at';

/** Days of the cost chart (spec 12: "cost today and 7 days", charted over a fortnight). */
export const COST_CHART_DAYS = 14;

/** Today plus the six local days before it. */
export const COST_WINDOW_DAYS = 7;

/** The dedupe key every `breaker_open` alert carries: `breaker:<connector>`. */
const BREAKER_KEY_PREFIX = 'breaker:';

export interface WatcherPartitionView {
  key: string;
  /** The stored cursor value, for example a Graph delta token. */
  cursor: string;
  updatedAt: string;
  ageMinutes: number;
}

export interface WatcherView {
  name: string;
  partitions: WatcherPartitionView[];
  /** When the watcher first ran, from its `__started_at` marker. */
  startedAt: string | null;
  /** Age of the freshest partition cursor. Null until a partition has run. */
  lastRunAgeMinutes: number | null;
}

export interface AgentSummaryView {
  name: string;
  runsToday: number;
  runs7Days: number;
  failuresToday: number;
  costTodayGbp: number;
  cost7DaysGbp: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface CostDayView {
  /** `YYYY-MM-DD` in the configured zone. */
  date: string;
  gbp: number;
}

export interface BreakerView {
  connector: string;
  state: string;
  /** The alert records no reset instant, so this is null until one is stored. */
  openUntil: string | null;
}

export interface AgentsStatus {
  system: { paused: boolean; pausedReason: string | null; mode: SystemMode };
  watchers: WatcherView[];
  agents: AgentSummaryView[];
  costToday: { gbp: number; ceilingGbp: number; fraction: number };
  costByDay: CostDayView[];
  pushesLastHour: number;
  breakers: BreakerView[];
}

/** Pounds to the nearest hundredth of a penny, so float noise never reaches the page. */
export function roundGbp(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Cursor rows grouped into watchers. `__started_at` is the start marker and
 * every other key is a partition, so a watcher that has never polled shows
 * as started with nothing behind it rather than as a partition called
 * `__started_at`.
 */
export function toWatcherViews(rows: CursorRow[], at: Date): WatcherView[] {
  const byWatcher = new Map<
    string,
    { started: string | null; partitions: WatcherPartitionView[] }
  >();

  for (const row of rows) {
    let entry = byWatcher.get(row.watcher);
    if (entry === undefined) {
      entry = { started: null, partitions: [] };
      byWatcher.set(row.watcher, entry);
    }
    if (row.key === STARTED_AT_KEY) {
      entry.started = row.value;
      continue;
    }
    entry.partitions.push({
      key: row.key,
      cursor: row.value,
      updatedAt: row.updatedAt.toISOString(),
      ageMinutes: ageMinutesBetween(at, row.updatedAt),
    });
  }

  return [...byWatcher.entries()]
    .map(([name, entry]) => ({
      name,
      partitions: [...entry.partitions].sort((left, right) => left.key.localeCompare(right.key)),
      startedAt: entry.started,
      lastRunAgeMinutes:
        entry.partitions.length === 0
          ? null
          : Math.min(...entry.partitions.map((partition) => partition.ageMinutes)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface AgentSummaryOptions {
  runs: AgentRunRow[];
  lastRuns: AgentLastRun[];
  /** Midnight at the start of the local day. */
  dayStart: Date;
  /** Midnight at the start of the local day `COST_WINDOW_DAYS` days ago. */
  weekStart: Date;
  usdToGbp: number;
}

/**
 * One row per agent, keyed by `agent_runs.agent`. The universe of agents
 * comes from the last runs rather than from the window, so an agent that
 * has gone quiet still shows, with zero counts and the run that stopped it.
 */
export function toAgentSummaries(options: AgentSummaryOptions): AgentSummaryView[] {
  const summaries = new Map<string, AgentSummaryView>();

  const entry = (name: string): AgentSummaryView => {
    const existing = summaries.get(name);
    if (existing !== undefined) return existing;
    const created: AgentSummaryView = {
      name,
      runsToday: 0,
      runs7Days: 0,
      failuresToday: 0,
      costTodayGbp: 0,
      cost7DaysGbp: 0,
      lastRunAt: null,
      lastError: null,
    };
    summaries.set(name, created);
    return created;
  };

  for (const run of options.lastRuns) {
    const summary = entry(run.agent);
    summary.lastRunAt = run.startedAt.toISOString();
    summary.lastError = run.error;
  }

  for (const run of options.runs) {
    const summary = entry(run.agent);
    const gbp = run.costUsd * options.usdToGbp;
    if (run.startedAt >= options.weekStart) {
      summary.runs7Days += 1;
      summary.cost7DaysGbp += gbp;
    }
    if (run.startedAt >= options.dayStart) {
      summary.runsToday += 1;
      summary.costTodayGbp += gbp;
      if (run.status === 'failed') summary.failuresToday += 1;
    }
  }

  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      costTodayGbp: roundGbp(summary.costTodayGbp),
      cost7DaysGbp: roundGbp(summary.cost7DaysGbp),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Spend per local day over the last `COST_CHART_DAYS`, oldest first and
 * zero-filled, so the chart has a bar for a quiet day rather than a gap.
 */
export function toCostByDay(
  runs: AgentRunRow[],
  at: Date,
  timeZone: string,
  usdToGbp: number,
): CostDayView[] {
  const totals = new Map<string, number>();
  for (let offset = COST_CHART_DAYS - 1; offset >= 0; offset -= 1) {
    totals.set(localDateOf(shiftLocalDays(at, -offset, timeZone), timeZone), 0);
  }

  for (const run of runs) {
    const date = localDateOf(run.startedAt, timeZone);
    const total = totals.get(date);
    if (total === undefined) continue;
    totals.set(date, total + run.costUsd * usdToGbp);
  }

  return [...totals.entries()].map(([date, gbp]) => ({ date, gbp: roundGbp(gbp) }));
}

/**
 * Open `breaker_open` alerts as breaker rows. An alert that has been acked,
 * muted or resolved is not an open breaker, so the caller passes only open
 * ones and every row here reads `open`.
 */
export function toBreakerViews(alerts: Alert[]): BreakerView[] {
  const byConnector = new Map<string, BreakerView>();
  for (const alert of alerts) {
    if (!alert.dedupeKey.startsWith(BREAKER_KEY_PREFIX)) continue;
    const connector = alert.dedupeKey.slice(BREAKER_KEY_PREFIX.length);
    if (connector === '') continue;
    byConnector.set(connector, { connector, state: 'open', openUntil: null });
  }
  return [...byConnector.values()].sort((left, right) =>
    left.connector.localeCompare(right.connector),
  );
}
