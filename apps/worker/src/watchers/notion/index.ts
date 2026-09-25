import {
  getPageText,
  getTask,
  isConnectorError,
  queryMeetingsEditedSince,
  queryOpenTasks,
  queryTasksEditedSince,
  type GetPageTextOptions,
  type NotionConnector,
  type QueryMeetingsArgs,
  type QueryMeetingsResult,
  type QueryOpenTasksArgs,
  type QueryTasksArgs,
  type QueryTasksResult,
  type TaskRecord,
} from '@lance/connectors';
import { nowIso } from '@lance/shared';
import type { Observation, PollResult, SourceRecord, Watcher } from '../types.js';
import {
  TASK_PARTITION,
  removedTaskIds,
  taskObservation,
  taskOf,
  taskRemovedObservation,
} from './tasks.js';
import { MEETING_PARTITION, meetingObservation, meetingOf } from './meetings.js';

/**
 * The `notion` watcher (spec 7.1): the All Tasks and Meetings databases,
 * every fifteen minutes, on the `last_edited_time` cursor. Everything here
 * is deterministic; no partition makes a model call.
 *
 * Lance reads both databases. Only All Tasks has writes, they live in the
 * executor, and they never reach this file.
 */

export const NOTION_WATCHER_NAME = 'notion';

/** Spec 7.1: every 15 minutes, at every hour of every day. */
export const NOTION_SCHEDULES = ['*/15 * * * *'] as const;

export const NOTION_PARTITIONS = [TASK_PARTITION, MEETING_PARTITION] as const;
export type NotionPartition = (typeof NOTION_PARTITIONS)[number];

/**
 * How far back each poll reaches beyond the stored cursor, to cover clock
 * skew between Lance and Notion. The overlap costs nothing: a page whose
 * content has not changed hashes the same and the ledger rejects it as a
 * duplicate.
 */
export const CURSOR_OVERLAP_MS = 2 * 60 * 1000;

/**
 * The window a first poll opens. Notion's filter needs a date, and a new
 * watcher has no cursor, so the first run reads the databases whole. It is
 * bounded by MAX_QUERY_PAGES in the connector and is idempotent, so the cost
 * is one slow run per partition.
 */
export const INITIAL_SINCE = '1970-01-01T00:00:00.000Z';

/** The connector reads the watcher needs, injected so tests need no HTTP. */
export interface NotionWatcherReads {
  queryTasksEditedSince(args: QueryTasksArgs): Promise<QueryTasksResult>;
  queryOpenTasks(args: QueryOpenTasksArgs): Promise<readonly TaskRecord[]>;
  queryMeetingsEditedSince(args: QueryMeetingsArgs): Promise<QueryMeetingsResult>;
  getPageText(pageId: string, options?: GetPageTextOptions): Promise<string>;
  getTask(pageId: string): Promise<TaskRecord>;
}

export interface NotionWatcherOptions {
  reads: NotionWatcherReads;
  /** `notion.tasksDataSourceId` from config. */
  tasksDataSourceId: string;
  /**
   * The principal's Notion user id (ADR 0022). Every task read is filtered
   * on it as assignee, so the shared All Tasks database yields only the
   * principal's own tasks. The watcher is not built while it is unresolved.
   */
  assigneeId: string;
  /** `notion.meetingsDataSourceId` from config; null leaves the meetings partition out entirely. */
  meetingsDataSourceId: string | null;
  /**
   * The ids of the tasks whose latest ledger observation is open and not
   * removed (`openNotionTaskIds`). Every tasks poll compares them against
   * the open tasks Notion still returns and records a removal for each one
   * that has gone: Notion leaves trashed pages out of every query, so no
   * cursor can see a deletion.
   */
  knownOpenTaskIds: () => Promise<readonly string[]>;
  now?: () => string;
  schedules?: readonly string[];
}

/** Binds the connector's free functions to one Notion connection. */
export function notionWatcherReads(notion: NotionConnector): NotionWatcherReads {
  return {
    queryTasksEditedSince: (args) => queryTasksEditedSince(notion, args),
    queryOpenTasks: (args) => queryOpenTasks(notion, args),
    queryMeetingsEditedSince: (args) => queryMeetingsEditedSince(notion, args),
    getPageText: (pageId, options) => getPageText(notion, pageId, options),
    getTask: (pageId) => getTask(notion, pageId),
  };
}

function partitionOf(partition: string): NotionPartition {
  const known = NOTION_PARTITIONS.find((candidate) => candidate === partition);
  if (known === undefined) {
    throw new Error(
      `The notion watcher was asked for partition "${partition}", which is not one of ${NOTION_PARTITIONS.join(', ')}. Remove the stale cursor row.`,
    );
  }
  return known;
}

/** The cursor, less the overlap. A missing cursor opens the whole window. */
function sinceFor(partition: string, cursor: string | null): string {
  if (cursor === null) return INITIAL_SINCE;
  const at = Date.parse(cursor);
  if (Number.isNaN(at)) {
    throw new Error(
      `The notion watcher's cursor for partition "${partition}" is "${cursor}", which is not an ISO instant. Delete the cursor row to backfill the partition.`,
    );
  }
  return new Date(at - CURSOR_OVERLAP_MS).toISOString();
}

/**
 * Newest edit last, so the runner advances the cursor to the newest
 * `last_edited_time` this poll saw. An empty poll returns no cursor and the
 * stored one stays where it is.
 */
function pollResultFor(
  records: readonly { readonly id: string; readonly lastEditedTime: string }[],
): PollResult {
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.lastEditedTime) - Date.parse(b.lastEditedTime),
  );
  return {
    records: sorted.map((record) => ({
      id: record.id,
      observedAt: record.lastEditedTime,
      raw: record,
    })),
    nextCursor: sorted.at(-1)?.lastEditedTime ?? null,
  };
}

export function createNotionWatcher(options: NotionWatcherOptions): Watcher {
  const now = options.now ?? nowIso;

  /**
   * Whether a known task the principal's queries no longer return was
   * reassigned to someone else, rather than trashed or shared away. One
   * page read each, for the few tasks that leave a principal's view in a
   * poll. A page Notion cannot find has gone; a page that still names the
   * principal as assignee yet came back from neither query is in the trash.
   */
  async function reassignedAway(id: string): Promise<boolean> {
    try {
      const page = await options.reads.getTask(id);
      return !page.assigneeIds.includes(options.assigneeId);
    } catch (error) {
      if (isConnectorError(error) && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * The removal sweep: one status-filtered read of the principal's open
   * tasks per poll (a few hundred rows, so a handful of calls), against the
   * open tasks the ledger knows. A task missing from both reads has left
   * the principal's view: reassigned to someone else, or removed from
   * Notion. The cursor is untouched; a removal is dated by the poll.
   */
  async function removedTaskRecords(edited: readonly TaskRecord[]): Promise<SourceRecord[]> {
    const known = await options.knownOpenTaskIds();
    if (known.length === 0) return [];
    const open = await options.reads.queryOpenTasks({
      dataSourceId: options.tasksDataSourceId,
      assigneeId: options.assigneeId,
    });
    const observedAt = now();
    const gone = removedTaskIds(
      known,
      edited.map((task) => task.id),
      open.map((task) => task.id),
    );
    const records: SourceRecord[] = [];
    for (const id of gone) {
      const reassigned = await reassignedAway(id);
      records.push({
        id,
        observedAt,
        raw: reassigned ? { id, reassigned } : { id },
        removed: true,
      });
    }
    return records;
  }

  return {
    name: NOTION_WATCHER_NAME,
    sourceSystem: 'notion',
    schedules: [...(options.schedules ?? NOTION_SCHEDULES)],
    // A Notion task is already a task: the Tasks page and the briefs read
    // the observations directly, and a Sonnet triage call per edit found
    // nothing to propose. The first poll over the database would have
    // queued three thousand of them. Revisit if the Meetings partition
    // comes back, since its debriefs travelled through triage.
    triage: false,

    partitions: () =>
      Promise.resolve(
        options.meetingsDataSourceId === null ? [TASK_PARTITION] : [...NOTION_PARTITIONS],
      ),

    async poll(partition: string, cursor: string | null): Promise<PollResult> {
      const kind = partitionOf(partition);
      const since = sinceFor(partition, cursor);
      if (kind === TASK_PARTITION) {
        const result = await options.reads.queryTasksEditedSince({
          dataSourceId: options.tasksDataSourceId,
          since,
          assigneeId: options.assigneeId,
        });
        const edited = pollResultFor(result.tasks);
        const removed = await removedTaskRecords(result.tasks);
        return { records: [...edited.records, ...removed], nextCursor: edited.nextCursor };
      }
      if (options.meetingsDataSourceId === null) {
        throw new Error(
          'The notion watcher was asked to poll the meetings partition but NOTION_MEETINGS_DATA_SOURCE_ID is not set. Remove the stale cursor row, or set the variable to watch the Meetings database.',
        );
      }
      const result = await options.reads.queryMeetingsEditedSince({
        dataSourceId: options.meetingsDataSourceId,
        since,
      });
      return pollResultFor(result.meetings);
    },

    async normalise(record: SourceRecord, partition: string): Promise<Observation> {
      if (partitionOf(partition) === TASK_PARTITION) {
        if (record.removed === true) return taskRemovedObservation(record);
        return taskObservation(taskOf(record));
      }
      return meetingObservation(meetingOf(record), { reads: options.reads, now: now() });
    },
  };
}

export {
  TASK_PARTITION,
  removedTaskIds,
  taskObservation,
  taskOf,
  taskRemovedObservation,
} from './tasks.js';
export type { NotionTaskRecord, NotionTaskRemovedRecord } from './tasks.js';
export { openNotionTaskIds } from './known.js';
export {
  MAX_NOTES_CHARS,
  MEETING_PARTITION,
  NOTES_FRESHNESS_HOURS,
  editedRecently,
  meetingObservation,
  meetingOf,
} from './meetings.js';
export type {
  MeetingNotesReader,
  MeetingObservationDeps,
  NotionMeetingRecord,
} from './meetings.js';
