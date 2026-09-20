import type { Db } from '@lance/db';
import { PgBoss } from 'pg-boss';
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
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values as never[]),
    },
  });
}

export async function startBoss(boss: PgBoss): Promise<void> {
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name);
  }
}
