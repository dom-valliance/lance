import type { Db } from '@lance/db';
import { PgBoss } from 'pg-boss';

/**
 * The api's end of the execute queue (spec 7.5). The worker owns the
 * consumer; the api only enqueues, so that approving a proposal in Slack or
 * in the web app reaches the executor the same way an auto decision does.
 *
 * pg-boss runs over the api's own pool, exactly as
 * `apps/worker/src/scheduler/boss.ts` does, so the Entra token password
 * (ADR 0008) applies to the queue as well.
 */

export const BOSS_SCHEMA = 'pgboss';
export const EXECUTE_QUEUE = 'execute';
export const CHASE_QUEUE = 'chase';
export const BRIEF_QUEUE = 'brief-morning';
/** The worker's reconciler (ADR 0025), asked to run after a job row changes. */
export const RECONCILE_QUEUE = 'jobs-reconcile';

/**
 * Every job the api puts on a queue names the principal it is for
 * (ADR 0025): the worker checks the id against `principals` and runs the
 * handler in that principal's scope. The caller passes the id, so package
 * 5.1 can pass the principal each request resolves to.
 */
interface PrincipalJob {
  principalId: string;
}

/** The job body the worker's executor consumes. */
export interface ExecuteJob extends PrincipalJob {
  proposalId: string;
}

/** The job body the worker's chase handler consumes (spec 9.2, 10.1 item 4). */
export interface ChaseJob extends PrincipalJob {
  commitmentId: string;
}

/** One pg-boss schedule for one of a principal's jobs. */
export interface JobSchedule {
  /** The job's slug, which is its queue. */
  slug: string;
  cron: string;
  timeZone: string;
}

export interface ExecuteQueue {
  enqueueExecute(principalId: string, proposalId: string): Promise<void>;
  /** Returns the pg-boss job id, which the caller shows to the principal. */
  enqueueChase(principalId: string, commitmentId: string): Promise<string>;
  /** Regenerates the principal's morning brief now (`/lance brief`, spec 9.2). */
  enqueueBrief(principalId: string): Promise<string>;
  /** Asks the worker to reconcile schedules after the principal's job rows changed. */
  enqueueReconcile(principalId: string): Promise<void>;
  /** The schedules the worker's reconciler holds for the principal, for `/lance jobs`. */
  schedulesFor(principalId: string): Promise<JobSchedule[]>;
  stop(): Promise<void>;
}

export function createBoss(db: Db): PgBoss {
  const pool = db.$client;
  return new PgBoss({
    schema: BOSS_SCHEMA,
    db: {
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values),
    },
  });
}

/**
 * Starts pg-boss on the first enqueue rather than at construction, so an
 * api process that never decides a proposal (a health probe, a local run
 * against an empty database) never opens the queue. The start promise is
 * kept, so concurrent decisions share one instance.
 */
export function createExecuteQueue(db: Db): ExecuteQueue {
  const boss = createBoss(db);
  let started: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    await boss.start();
    await boss.createQueue(EXECUTE_QUEUE);
    await boss.createQueue(CHASE_QUEUE);
    await boss.createQueue(BRIEF_QUEUE);
    await boss.createQueue(RECONCILE_QUEUE);
  };

  return {
    async enqueueExecute(principalId: string, proposalId: string): Promise<void> {
      started ??= start();
      await started;
      const job: ExecuteJob = { principalId, proposalId };
      await boss.send(EXECUTE_QUEUE, job);
    },

    async enqueueBrief(principalId: string): Promise<string> {
      started ??= start();
      await started;
      const job: PrincipalJob = { principalId };
      const jobId = await boss.send(BRIEF_QUEUE, job);
      if (jobId === null) {
        throw new Error(
          'The brief queue refused the job. Check that the worker is running and that the pgboss schema is present.',
        );
      }
      return jobId;
    },

    async enqueueChase(principalId: string, commitmentId: string): Promise<string> {
      started ??= start();
      await started;
      const job: ChaseJob = { principalId, commitmentId };
      const jobId = await boss.send(CHASE_QUEUE, job);
      if (jobId === null) {
        throw new Error(
          `The chase queue refused the job for commitment ${commitmentId}. Check that the worker is running and that the pgboss schema is present.`,
        );
      }
      return jobId;
    },

    async enqueueReconcile(principalId: string): Promise<void> {
      started ??= start();
      await started;
      const job: PrincipalJob = { principalId };
      await boss.send(RECONCILE_QUEUE, job);
    },

    async schedulesFor(principalId: string): Promise<JobSchedule[]> {
      started ??= start();
      await started;
      // Keys are `<slug>/<principalId>`, with `/<n>` for a job with several crons.
      return (await boss.getSchedules())
        .filter((schedule) => schedule.key.split('/')[1] === principalId)
        .map((schedule) => ({
          slug: schedule.name,
          cron: schedule.cron,
          timeZone: schedule.timezone,
        }));
    },

    async stop(): Promise<void> {
      if (started === null) return;
      await started;
      await boss.stop({ graceful: true });
      started = null;
    },
  };
}
