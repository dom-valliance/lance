import { observations, type Db } from '@lance/db';
import { and, desc, eq, lt, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { NOTION_CLOSED_STATUSES, type ObservationRecord, type TaskSource } from './view.js';

/**
 * Reads tasks out of `observations`: one row per source record, the latest
 * observation of it. Nothing here writes, and nothing reaches Notion or
 * Jamie: the watchers already recorded everything the page shows.
 */

export interface TaskQuery {
  source?: TaskSource;
  status?: 'open' | 'done';
  /** Rows to return. The caller asks for one more than the page size to learn whether another page exists. */
  limit: number;
  /** The id of the last row of the previous page; rows are ordered by id, newest first. */
  cursor?: string;
}

export interface TaskStoreLike {
  list(query: TaskQuery): Promise<ObservationRecord[]>;
}

const notionClosedList = sql.join(
  NOTION_CLOSED_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * True for a task the source no longer treats as open. The list lives in
 * `view.ts`, so the SQL filter and the rendered `done` flag cannot drift.
 */
const doneCondition = (source: SQLWrapper, payload: SQLWrapper): SQL =>
  sql`((${source} = 'notion' and ${payload}->>'status' in (${notionClosedList})) or (${source} = 'jamie' and ${payload}->>'completed' = 'true'))`;

export function createTaskStore(db: Db): TaskStoreLike {
  return {
    async list(query: TaskQuery): Promise<ObservationRecord[]> {
      // Only the source and the payload kind are stable enough to filter on
      // inside the DISTINCT ON: a status filter here would pick the newest
      // observation that still matched, rather than the newest observation.
      const inner: SQL[] = [sql`${observations.payload}->>'kind' = 'task'`];
      inner.push(
        query.source === undefined
          ? sql`${observations.sourceSystem} in ('notion', 'jamie')`
          : eq(observations.sourceSystem, query.source),
      );

      const latest = db
        .selectDistinctOn([observations.sourceRecordId], {
          id: observations.id,
          ts: observations.ts,
          sourceSystem: observations.sourceSystem,
          sourceRecordId: observations.sourceRecordId,
          payload: observations.payload,
        })
        .from(observations)
        .where(and(...inner))
        .orderBy(observations.sourceRecordId, desc(observations.ts), desc(observations.id))
        .as('latest');

      const outer: SQL[] = [];
      if (query.cursor !== undefined) outer.push(lt(latest.id, query.cursor));
      if (query.status === 'done') outer.push(doneCondition(latest.sourceSystem, latest.payload));
      if (query.status === 'open') {
        outer.push(sql`not ${doneCondition(latest.sourceSystem, latest.payload)}`);
      }

      const rows = await db
        .select()
        .from(latest)
        .where(outer.length === 0 ? undefined : and(...outer))
        .orderBy(desc(latest.id))
        .limit(query.limit);

      return rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        sourceSystem: row.sourceSystem,
        sourceRecordId: row.sourceRecordId,
        payload: row.payload,
      }));
    },
  };
}
