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

/** The job body the worker's executor consumes. */
export interface ExecuteJob {
  proposalId: string;
}

/** The job body the worker's chase handler consumes (spec 9.2, 10.1 item 4). */
export interface ChaseJob {
  commitmentId: string;
}

export interface ExecuteQueue {
  enqueueExecute(proposalId: string): Promise<void>;
  /** Returns the pg-boss job id, which the caller shows to Dom. */
  enqueueChase(commitmentId: string): Promise<string>;
  /** Regenerates the morning brief now (`/lance brief`, spec 9.2). */
  enqueueBrief(): Promise<string>;
  stop(): Promise<void>;
}

export function createBoss(db: Db): PgBoss {
  const pool = db.$client;
  return new PgBoss({
    schema: BOSS_SCHEMA,
    db: {
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values as never[]),
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
  };

  return {
    async enqueueExecute(proposalId: string): Promise<void> {
      started ??= start();
      await started;
      const job: ExecuteJob = { proposalId };
      await boss.send(EXECUTE_QUEUE, job);
    },

    async enqueueBrief(): Promise<string> {
      started ??= start();
      await started;
      const jobId = await boss.send(BRIEF_QUEUE, {});
      if (jobId === null) {
        throw new Error(
          'The brief queue refused the job. Check that the worker is running and that the pgboss schema is present.',
        );
      }
      return jobId;
    },

    async enqueueChase(commitmentId: string): Promise<string> {
      started ??= start();
      await started;
      const job: ChaseJob = { commitmentId };
      const jobId = await boss.send(CHASE_QUEUE, job);
      if (jobId === null) {
        throw new Error(
          `The chase queue refused the job for commitment ${commitmentId}. Check that the worker is running and that the pgboss schema is present.`,
        );
      }
      return jobId;
    },
    async stop(): Promise<void> {
      if (started === null) return;
      await started;
      await boss.stop({ graceful: true });
      started = null;
    },
  };
}
