/**
 * View model for the Agents page (spec 12, Agents row: "Each agent and
 * watcher: last run, age, cursor, breaker state, error tail, cost today
 * and 7 days, token chart. Global cost chart."). No chart library is used
 * (see the task brief); the cost sections render as a CSS width bar and a
 * compact table instead.
 *
 * The `agents` router as another engineer is adding it to `apps/api` at
 * the same time as this page (see the tRPC contract in the task brief).
 * `AppRouter` (imported in `@/lib/trpc`) does not carry `agents` yet, so
 * this narrow contract stands in for it, following the same pattern as
 * `commitmentsRouter` in `apps/web/src/lib/commitment-view.ts`: the api
 * router is the source of truth once it lands, and this interface and the
 * cast in `agentsRouter` are deleted then in favour of calling
 * `client.agents` directly.
 */

import type { ApiClient } from '@/lib/trpc';
import { formatAgeMinutes } from '@/lib/time';

export interface AgentsSystemState {
  paused: boolean;
  pausedReason: string | null;
  mode: string;
}

export interface WatcherPartition {
  key: string;
  cursor: string;
  updatedAt: string;
  ageMinutes: number;
}

export interface WatcherStatus {
  name: string;
  partitions: WatcherPartition[];
  startedAt: string | null;
  lastRunAgeMinutes: number | null;
}

export interface AgentStatus {
  name: string;
  runsToday: number;
  runs7Days: number;
  failuresToday: number;
  costTodayGbp: number;
  cost7DaysGbp: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface CostToday {
  gbp: number;
  ceilingGbp: number;
  fraction: number;
}

export interface CostByDay {
  date: string;
  gbp: number;
}

export interface Breaker {
  connector: string;
  state: string;
  openUntil: string | null;
}

export interface AgentsStatus {
  system: AgentsSystemState;
  watchers: WatcherStatus[];
  agents: AgentStatus[];
  costToday: CostToday;
  costByDay: CostByDay[];
  pushesLastHour: number;
  breakers: Breaker[];
}

export interface AgentsRouterContract {
  status: { query(): Promise<AgentsStatus> };
}

/** The one place the stand-in cast above lives. */
export function agentsRouter(client: ApiClient): AgentsRouterContract {
  return (client as unknown as { agents: AgentsRouterContract }).agents;
}

/** "Running, live mode" or "Paused: <reason>". */
export function systemStateLabel(system: AgentsSystemState): string {
  if (system.paused) {
    return system.pausedReason === null || system.pausedReason === ''
      ? 'Paused.'
      : `Paused: ${system.pausedReason}`;
  }
  return `Running, ${system.mode} mode.`;
}

/** "3 min ago", "2 h ago", or "no runs yet" for a watcher or agent's last activity. */
export function ageLabel(ageMinutes: number | null): string {
  return ageMinutes === null ? 'no runs yet' : `${formatAgeMinutes(ageMinutes)} ago`;
}

/** The error tail a table cell shows, truncated so one bad line cannot blow out the row. */
export const ERROR_TAIL_MAX = 120;

export function truncateTail(value: string | null, max: number = ERROR_TAIL_MAX): string | null {
  if (value === null || value === '') return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** The cost bar's fill width, clamped so a day over ceiling still draws a full bar. */
export function costBarWidthPercent(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 10_000) / 100;
}

/** "27%", the true percentage even when spend has gone past the ceiling. */
export function costPercentLabel(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** True once the day's spend has reached or passed the ceiling (spec 13: pauses model agents at 100%). */
export function isOverCeiling(fraction: number): boolean {
  return fraction >= 1;
}

/** "3 pushes in the last hour", "No pushes in the last hour." */
export function pushesLabel(pushesLastHour: number): string {
  if (pushesLastHour === 0) return 'No pushes in the last hour.';
  return `${String(pushesLastHour)} push${pushesLastHour === 1 ? '' : 'es'} in the last hour.`;
}

/** True while a breaker is not simply closed, which the page marks with a warmer tone. */
export function isBreakerConcerning(state: string): boolean {
  return state !== 'closed';
}
