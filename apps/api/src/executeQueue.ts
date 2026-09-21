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

/** The job body the worker's executor consumes. */
export interface ExecuteJob {
  proposalId: string;
}

export interface ExecuteQueue {
  enqueueExecute(proposalId: string): Promise<void>;
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
  };

  return {
    async enqueueExecute(proposalId: string): Promise<void> {
      started ??= start();
      await started;
      const job: ExecuteJob = { proposalId };
      await boss.send(EXECUTE_QUEUE, job);
    },
    async stop(): Promise<void> {
      if (started === null) return;
      await started;
      await boss.stop({ graceful: true });
      started = null;
    },
  };
}
