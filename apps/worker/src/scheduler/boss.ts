import type { Db } from '@lance/db';
import { PgBoss, type Job } from 'pg-boss';
import { QUEUES } from './queues.js';

export const BOSS_SCHEMA = 'pgboss';

/**
 * pg-boss over the same pool as the rest of the worker so the Entra token
 * password (ADR 0008) applies to the queue as well. The schema is created by
 * migration 0003 and owned by lance_app; pg-boss creates its tables inside it.
 */
export function createBoss(db: Db): PgBoss {
  const pool = db.$client;
  return new PgBoss({
    schema: BOSS_SCHEMA,
    db: {
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values),
    },
  });
}

export async function startBoss(boss: PgBoss): Promise<void> {
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name);
  }
}

/**
 * `boss.work` with the one thing pg-boss does not do: say so when a job
 * fails. pg-boss records the error on the job row and retries quietly,
 * which leaves the console log empty while briefs and detectors fail. The
 * failure is logged with the queue and job ids, then rethrown so pg-boss
 * still records and retries it. `docs/runbooks/observing.md` reads both.
 */
/** The pg-boss worker options the worker sets; everything else keeps pg-boss's default. */
export interface WorkQueueOptions {
  /** Jobs of the queue this process runs at once; pg-boss defaults to one. */
  localConcurrency?: number;
  /**
   * How long a worker waits between fetches, less the time the last job
   * took; pg-boss defaults to two seconds, so a queue of quick jobs runs
   * at most one every two seconds per worker.
   */
  pollingIntervalSeconds?: number;
  /**
   * How many jobs of one group (a principal, `principalJobOptions`) this
   * process runs at once. Tracked in memory by pg-boss, so it holds within
   * one worker process; jobs sent without a group are not limited.
   */
  localGroupConcurrency?: number;
}

export function work<T>(
  boss: PgBoss,
  queue: string,
  handler: (jobs: Job<T>[]) => Promise<void>,
  options: WorkQueueOptions = {},
): Promise<string> {
  return boss.work<T>(queue, options, async (jobs) => {
    try {
      await handler(jobs);
    } catch (error) {
      console.error(
        {
          queue,
          jobIds: jobs.map((job) => job.id),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        'job failed',
      );
      throw error;
    }
  });
}
