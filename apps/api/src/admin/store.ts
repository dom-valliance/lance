import { scopedDb, type Db } from '@lance/db';
import { sql } from 'drizzle-orm';
import { COST_WINDOW_DAYS, STARTED_AT_KEY } from '../agents/view.js';
import type {
  AdminPrincipalView,
  AdminStoreLike,
  PrincipalDirectoryLike,
  PrincipalHealth,
  PrincipalRef,
} from '../deps.js';
import { ageMinutesBetween, shiftLocalDays, startOfLocalDay } from '../status.js';

/**
 * The reads behind the admin procedures (ADR 0024). Each principal's health
 * is one statement run in that principal's own scope, so row-level security
 * decides what it can see exactly as it does for the principal. The
 * statement selects ages, counts and sums; it names no column that holds
 * content, so there is nothing for a response to leak.
 */

export interface AdminStoreOptions {
  usdToGbp: number;
  timeZone: string;
  /** Injected in tests. */
  now?: () => Date;
}

/** The dedupe key every `breaker_open` alert carries: `breaker:<connector>`. */
const BREAKER_PREFIX = 'breaker:';

interface HealthRow extends Record<string, unknown> {
  watchers: { watcher: string; last_run_at: string }[];
  breakers: string[];
  cost_today_usd: string;
  cost_week_usd: string;
}

const roundGbp = (value: number): number => Math.round(value * 10_000) / 10_000;

export function createAdminStore(
  root: Db,
  directory: PrincipalDirectoryLike,
  options: AdminStoreOptions,
): AdminStoreLike {
  const now = options.now ?? ((): Date => new Date());

  const healthOf = async (principal: PrincipalRef, at: Date): Promise<PrincipalHealth> => {
    const dayStart = startOfLocalDay(at, options.timeZone);
    const weekStart = shiftLocalDays(at, -(COST_WINDOW_DAYS - 1), options.timeZone);
    const scoped = scopedDb(root, { principalId: principal.id });
    const result = await scoped.execute<HealthRow>(sql`
      SELECT
        (SELECT coalesce(json_agg(json_build_object('watcher', w.watcher, 'last_run_at', w.last_run_at)
                                  ORDER BY w.watcher), '[]'::json)
           FROM (SELECT watcher, max(updated_at) AS last_run_at FROM cursors
                 WHERE key <> ${STARTED_AT_KEY} GROUP BY watcher) w) AS watchers,
        (SELECT coalesce(json_agg(DISTINCT dedupe_key), '[]'::json) FROM alerts
           WHERE kind = 'breaker_open' AND status = 'open'
             AND dedupe_key LIKE ${`${BREAKER_PREFIX}%`}) AS breakers,
        (SELECT coalesce(sum(estimated_cost_usd), 0)::text FROM agent_runs
           WHERE started_at >= ${dayStart.toISOString()}::timestamptz) AS cost_today_usd,
        (SELECT coalesce(sum(estimated_cost_usd), 0)::text FROM agent_runs
           WHERE started_at >= ${weekStart.toISOString()}::timestamptz) AS cost_week_usd
    `);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`The health read for principal ${principal.id} returned no row.`);
    }
    return {
      principalId: principal.id,
      upn: principal.upn,
      status: principal.status,
      watchers: row.watchers.map((watcher) => ({
        watcher: watcher.watcher,
        lastRunAgeMinutes: ageMinutesBetween(at, new Date(watcher.last_run_at)),
      })),
      breakers: row.breakers
        .map((key) => key.slice(BREAKER_PREFIX.length))
        .filter((connector) => connector !== '')
        .sort()
        .map((connector) => ({ connector, state: 'open' as const })),
      costTodayGbp: roundGbp(Number(row.cost_today_usd) * options.usdToGbp),
      costWeekGbp: roundGbp(Number(row.cost_week_usd) * options.usdToGbp),
    };
  };

  return {
    async principals(): Promise<AdminPrincipalView[]> {
      const all = await directory.list();
      return all.map((principal) => ({
        id: principal.id,
        upn: principal.upn,
        status: principal.status,
        createdAt: principal.createdAt.toISOString(),
      }));
    },

    async health(): Promise<PrincipalHealth[]> {
      const at = now();
      const all = await directory.list();
      const health: PrincipalHealth[] = [];
      for (const principal of all) {
        if (principal.status === 'offboarded') continue;
        health.push(await healthOf(principal, at));
      }
      return health;
    },
  };
}
