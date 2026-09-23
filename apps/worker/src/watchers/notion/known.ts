import { TASK_CLOSED_STATUSES } from '@lance/connectors';
import { newestObservationFirst, observations, type Db } from '@lance/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The Notion tasks the ledger currently believes are open: the latest
 * observation of each All Tasks page, kept when its status is not closed
 * and it has not already been recorded as removed. The watcher's removal
 * sweep starts from this list, so a task is reported gone once and never
 * again.
 */
export async function openNotionTaskIds(db: Db): Promise<string[]> {
  const latest = db
    .selectDistinctOn([observations.sourceRecordId], {
      sourceRecordId: observations.sourceRecordId,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        eq(observations.sourceSystem, 'notion'),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(...newestObservationFirst())
    .as('latest');
  const closed = sql.join(
    TASK_CLOSED_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const rows = await db
    .select({ id: latest.sourceRecordId })
    .from(latest)
    .where(
      and(
        sql`coalesce(${latest.payload} ->> 'removed', 'false') <> 'true'`,
        sql`coalesce(${latest.payload} ->> 'status', '') not in (${closed})`,
      ),
    );
  return rows.map((row) => row.id);
}
