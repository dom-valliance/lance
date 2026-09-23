import { newestObservationFirst, observations, type Db } from '@lance/db';
import { and, count, desc, eq, lt, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
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

/** The filters a count honours: the list's, without the page it would cut. */
export type TaskCountQuery = Omit<TaskQuery, 'limit' | 'cursor'>;

export interface TaskStoreLike {
  list(query: TaskQuery): Promise<ObservationRecord[]>;
  /** Every row `list` would return across all its pages, over the same newest observations. */
  count(query: TaskCountQuery): Promise<number>;
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

/**
 * The newest observation of every task record, as a subquery. Only the
 * source and the payload kind are stable enough to filter on inside the
 * DISTINCT ON: a status filter here would pick the newest observation that
 * still matched, rather than the newest observation.
 */
function latestTasks(db: Db, source: TaskSource | undefined) {
  const inner: SQL[] = [sql`${observations.payload}->>'kind' = 'task'`];
  inner.push(
    source === undefined
      ? sql`${observations.sourceSystem} in ('notion', 'jamie')`
      : eq(observations.sourceSystem, source),
  );

  return db
    .selectDistinctOn([observations.sourceRecordId], {
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      payload: observations.payload,
    })
    .from(observations)
    .where(and(...inner))
    .orderBy(...newestObservationFirst())
    .as('latest');
}

type LatestTasks = ReturnType<typeof latestTasks>;

/**
 * The conditions over the newest observations that `list` and `count`
 * share. A page the watcher recorded as removed has left Notion: it is not
 * open, not done, just gone, whichever filter the page sends.
 */
function outerConditions(latest: LatestTasks, status: TaskQuery['status']): SQL[] {
  const outer: SQL[] = [sql`coalesce(${latest.payload}->>'removed', 'false') <> 'true'`];
  if (status === 'done') outer.push(doneCondition(latest.sourceSystem, latest.payload));
  if (status === 'open') outer.push(sql`not ${doneCondition(latest.sourceSystem, latest.payload)}`);
  return outer;
}

export function createTaskStore(db: Db): TaskStoreLike {
  return {
    async list(query: TaskQuery): Promise<ObservationRecord[]> {
      const latest = latestTasks(db, query.source);
      const outer = outerConditions(latest, query.status);
      if (query.cursor !== undefined) outer.push(lt(latest.id, query.cursor));

      const rows = await db
        .select()
        .from(latest)
        .where(and(...outer))
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

    async count(query: TaskCountQuery): Promise<number> {
      const latest = latestTasks(db, query.source);
      const rows = await db
        .select({ total: count() })
        .from(latest)
        .where(and(...outerConditions(latest, query.status)));
      return rows[0]?.total ?? 0;
    },
  };
}
