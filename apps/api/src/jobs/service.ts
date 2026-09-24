import type { Db } from '@lance/db';
import { JobControl } from '@lance/ledger';
import { nextRun, nowIso } from '@lance/shared';
import type { ExecuteQueue, JobSchedule } from '../executeQueue.js';

/**
 * The api's side of the job registry (ADR 0025): the caller's job rows,
 * their next runs, and enabling or disabling one. The api writes the row
 * and its `state_changed` event through `JobControl`, then asks the
 * worker's reconciler to run, so the schedule follows within seconds. The
 * registry itself lives in the worker; the row's `locked` flag, which the
 * reconciler keeps equal to the declaration, is what refuses a disable.
 */

export interface JobListing {
  slug: string;
  enabled: boolean;
  locked: boolean;
  /** ISO instant of the next scheduled run, or null when nothing is scheduled. */
  nextRunAt: string | null;
}

export type JobToggleStatus = 'changed' | 'unchanged' | 'locked' | 'unknown';

export interface JobsServiceLike {
  list(): Promise<JobListing[]>;
  setEnabled(slug: string, enabled: boolean, actor: string): Promise<JobToggleStatus>;
}

export interface JobsServiceDeps {
  /** Scoped to the principal whose jobs these are. */
  db: Db;
  principalId: string;
  queue: Pick<ExecuteQueue, 'enqueueReconcile' | 'schedulesFor'>;
  now?: () => string;
}

/** The earliest next run among a job's schedules, or null when it has none. */
export function nextRunOf(
  schedules: readonly JobSchedule[],
  slug: string,
  from: Date,
): string | null {
  const own = schedules.filter((schedule) => schedule.slug === slug);
  const zone = own[0]?.timeZone;
  if (zone === undefined) return null;
  return (
    nextRun(
      own.map((schedule) => schedule.cron),
      zone,
      from,
    )?.toISOString() ?? null
  );
}

export function createJobsService(deps: JobsServiceDeps): JobsServiceLike {
  const control = new JobControl(deps.db);
  return {
    async list() {
      const [rows, schedules] = await Promise.all([
        control.list(),
        deps.queue.schedulesFor(deps.principalId),
      ]);
      const from = new Date((deps.now ?? nowIso)());
      return rows.map((row) => ({
        slug: row.slug,
        enabled: row.enabled || row.locked,
        locked: row.locked,
        nextRunAt: nextRunOf(schedules, row.slug, from),
      }));
    },

    async setEnabled(slug, enabled, actor) {
      const result = await control.setEnabled(slug, enabled, { actor });
      if (result.status === 'changed') await deps.queue.enqueueReconcile(deps.principalId);
      return result.status;
    },
  };
}
