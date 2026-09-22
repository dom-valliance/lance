import {
  getPageText,
  queryMeetingsEditedSince,
  queryTasksEditedSince,
  type GetPageTextOptions,
  type NotionConnector,
  type QueryMeetingsArgs,
  type QueryMeetingsResult,
  type QueryTasksArgs,
  type QueryTasksResult,
} from '@lance/connectors';
import { nowIso } from '@lance/shared';
import type { Observation, PollResult, SourceRecord, Watcher } from '../types.js';
import { TASK_PARTITION, taskObservation, taskOf } from './tasks.js';
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
  queryMeetingsEditedSince(args: QueryMeetingsArgs): Promise<QueryMeetingsResult>;
  getPageText(pageId: string, options?: GetPageTextOptions): Promise<string>;
}

export interface NotionWatcherOptions {
  reads: NotionWatcherReads;
  /** `notion.tasksDataSourceId` from config. */
  tasksDataSourceId: string;
  /** `notion.meetingsDataSourceId` from config. */
  meetingsDataSourceId: string;
  now?: () => string;
  schedules?: readonly string[];
}

/** Binds the connector's free functions to one Notion connection. */
export function notionWatcherReads(notion: NotionConnector): NotionWatcherReads {
  return {
    queryTasksEditedSince: (args) => queryTasksEditedSince(notion, args),
    queryMeetingsEditedSince: (args) => queryMeetingsEditedSince(notion, args),
    getPageText: (pageId, options) => getPageText(notion, pageId, options),
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

  return {
    name: NOTION_WATCHER_NAME,
    sourceSystem: 'notion',
    schedules: [...(options.schedules ?? NOTION_SCHEDULES)],

    partitions: () => Promise.resolve([...NOTION_PARTITIONS]),

    async poll(partition: string, cursor: string | null): Promise<PollResult> {
      const kind = partitionOf(partition);
      const since = sinceFor(partition, cursor);
      if (kind === TASK_PARTITION) {
        const result = await options.reads.queryTasksEditedSince({
          dataSourceId: options.tasksDataSourceId,
          since,
        });
        return pollResultFor(result.tasks);
      }
      const result = await options.reads.queryMeetingsEditedSince({
        dataSourceId: options.meetingsDataSourceId,
        since,
      });
      return pollResultFor(result.meetings);
    },

    async normalise(record: SourceRecord, partition: string): Promise<Observation> {
      if (partitionOf(partition) === TASK_PARTITION) {
        return taskObservation(taskOf(record));
      }
      return meetingObservation(meetingOf(record), { reads: options.reads, now: now() });
    },
  };
}

export { TASK_PARTITION, taskObservation, taskOf } from './tasks.js';
export type { NotionTaskRecord } from './tasks.js';
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
