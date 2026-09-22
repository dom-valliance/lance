/**
 * The Tasks page (spec 12, Tasks row) reads the ledger's `observations`
 * table, not the sources: the latest observation of each Notion All Tasks
 * page and each Jamie action item. Everything here is a pure function over
 * one observation payload, so the mapping is testable without a database.
 *
 * Jamie tasks are read-only (ADR 0005): the view carries a link and no
 * action. Completing a Notion task is a proposal, and arrives later.
 */

import { TASK_CLOSED_STATUSES } from '@lance/connectors';

export type TaskSource = 'notion' | 'jamie';

export interface TaskView {
  /** `<source>:<sourceId>`, unique across both sources. */
  id: string;
  source: TaskSource;
  sourceId: string;
  title: string;
  /** The source's own status text; Jamie gives `open` or `completed`. */
  status: string;
  done: boolean;
  /** YYYY-MM-DD when the source holds a date; Jamie holds none. */
  due: string | null;
  assigneeName: string | null;
  assignedToDom: boolean;
  url: string | null;
  observedAt: string;
  /** Jamie only: the meeting the action item came out of. */
  meetingTitle: string | null;
}

/**
 * The All Tasks statuses that mean the row is no longer open. Cancelled and
 * Archived are closed rather than completed, and the Tasks page treats both
 * as done so an open filter shows only live work. The store filters in SQL
 * with this same list.
 */
export const NOTION_CLOSED_STATUSES = TASK_CLOSED_STATUSES;

/** What Notion returns when a task page carries no status at all. */
export const UNKNOWN_STATUS = 'Unknown';

const UNTITLED = '(untitled)';

/** One observation as the store reads it back. */
export interface ObservationRecord {
  id: string;
  ts: Date;
  sourceSystem: string;
  sourceRecordId: string;
  payload: unknown;
}

export interface TaskViewOptions {
  /** `config.notion.domUserId`; an All Tasks row assigned to it is Dom's. */
  domNotionUserId: string;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function strings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** True for the payload of a task observation, from either source. */
export function isTaskPayload(payload: unknown): boolean {
  return asRecord(payload)?.['kind'] === 'task';
}

export function isNotionTaskDone(status: string): boolean {
  return (NOTION_CLOSED_STATUSES as readonly string[]).includes(status);
}

function notionTaskView(
  row: ObservationRecord,
  record: Record<string, unknown>,
  options: TaskViewOptions,
): TaskView {
  const status = str(record, 'status') ?? UNKNOWN_STATUS;
  return {
    id: `notion:${row.sourceRecordId}`,
    source: 'notion',
    sourceId: row.sourceRecordId,
    title: str(record, 'title') ?? UNTITLED,
    status,
    done: isNotionTaskDone(status),
    due: str(record, 'due'),
    // The All Tasks DB holds assignee ids, not names; the page shows whose
    // it is through `assignedToDom` until the ontology fills the rest in.
    assigneeName: null,
    assignedToDom: strings(record, 'assigneeIds').includes(options.domNotionUserId),
    url: str(record, 'url'),
    observedAt: row.ts.toISOString(),
    meetingTitle: null,
  };
}

function jamieTaskView(row: ObservationRecord, record: Record<string, unknown>): TaskView {
  const completed = record['completed'] === true;
  return {
    id: `jamie:${row.sourceRecordId}`,
    source: 'jamie',
    sourceId: row.sourceRecordId,
    title: str(record, 'text') ?? UNTITLED,
    status: completed ? 'completed' : 'open',
    done: completed,
    // Jamie's action items carry no due date of their own.
    due: null,
    assigneeName: str(record, 'assigneeName'),
    assignedToDom: record['assignedToDom'] === true,
    url: str(record, 'url'),
    observedAt: row.ts.toISOString(),
    meetingTitle: str(record, 'meetingTitle'),
  };
}

/**
 * One observation as a task, or null when the row is not a task observation
 * of a source the page knows.
 */
export function toTaskView(row: ObservationRecord, options: TaskViewOptions): TaskView | null {
  const record = asRecord(row.payload);
  if (record === null || record['kind'] !== 'task') return null;
  if (row.sourceSystem === 'notion') return notionTaskView(row, record, options);
  if (row.sourceSystem === 'jamie') return jamieTaskView(row, record);
  return null;
}

export function toTaskViews(
  rows: readonly ObservationRecord[],
  options: TaskViewOptions,
): TaskView[] {
  const views: TaskView[] = [];
  for (const row of rows) {
    const view = toTaskView(row, options);
    if (view !== null) views.push(view);
  }
  return views;
}
