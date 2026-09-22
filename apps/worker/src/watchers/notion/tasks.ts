import type { TaskRecord } from '@lance/connectors';
import type { Observation, SourceRecord } from '../types.js';

/**
 * The tasks half of the `notion` watcher: the All Tasks DB (ADR 0009), read
 * only. Writing a task is the executor's job and goes through a proposal.
 */

export const TASK_PARTITION = 'tasks';

const MAX_SUMMARY_CHARS = 200;

/**
 * The canonical task record. `lastEditedTime` is deliberately dropped, and
 * `Last edited by` is never read at all: both change whenever anyone touches
 * the page, and the record's hash is the third part of the idempotency key.
 * Keeping either would turn a no-op edit, a rollup refresh or a Notion
 * re-save into a fresh observation.
 */
export type NotionTaskRecord = Omit<TaskRecord, 'lastEditedTime'> & { kind: 'task' };

/**
 * What the ledger holds once a task page has left the database: moved to
 * the trash, archived, or shared away from the integration. Notion returns
 * none of those from a query, so the watcher infers the removal by
 * comparing the open tasks it knows against the open tasks Notion still
 * returns. Live records carry no `removed` field at all, so recording the
 * first removal does not change the hash of every live task.
 */
export type NotionTaskRemovedRecord = { kind: 'task'; id: string; removed: true };

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function isTaskRecord(raw: unknown): raw is TaskRecord {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.id === 'string' && typeof value.lastEditedTime === 'string';
}

/**
 * The task `poll` put in `raw`. `poll` stores the connector's already
 * normalised record, so `normalise` re-reads it rather than parsing Notion's
 * JSON a second time; the check keeps the cast honest.
 */
export function taskOf(record: SourceRecord): TaskRecord {
  if (!isTaskRecord(record.raw)) {
    throw new Error(
      `The notion watcher was handed a record for page ${record.id} that is not a TaskRecord. Only poll may fill SourceRecord.raw for the tasks partition.`,
    );
  }
  return record.raw;
}

/** The removal of one All Tasks row as a ledger observation. */
export function taskRemovedObservation(record: SourceRecord): Observation {
  const canonical: NotionTaskRemovedRecord = { kind: 'task', id: record.id, removed: true };
  return {
    sourceSystem: 'notion',
    recordId: record.id,
    observedAt: record.observedAt,
    record: canonical,
    correlationKey: record.id,
    summary: 'Task removed from Notion',
    labels: ['Notion', 'Task', 'Removed'],
  };
}

/**
 * The ids of known open tasks that neither the edit window nor the open
 * sweep returned. A page closed since the last poll arrives through the
 * edit window, so what is left is a page Notion no longer returns at all.
 */
export function removedTaskIds(
  knownOpenIds: readonly string[],
  editedIds: readonly string[],
  openIds: readonly string[],
): string[] {
  const seen = new Set([...editedIds, ...openIds]);
  return knownOpenIds.filter((id) => !seen.has(id));
}

/** One All Tasks row as a ledger observation. No model call. */
export function taskObservation(task: TaskRecord): Observation {
  const { lastEditedTime, ...rest } = task;
  const canonical: NotionTaskRecord = { ...rest, kind: 'task' };
  const title = task.title.trim() === '' ? '(untitled)' : task.title;
  return {
    sourceSystem: 'notion',
    recordId: task.id,
    observedAt: lastEditedTime,
    record: canonical,
    correlationKey: task.id,
    summary: cap(`Task: ${title}`, MAX_SUMMARY_CHARS),
    labels: ['Notion', 'Task'],
    url: task.url,
  };
}
