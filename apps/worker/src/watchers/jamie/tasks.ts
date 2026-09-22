import type { JamieReads, JamieTask } from '@lance/connectors';
import type { Observation, PollResult, SourceRecord } from '../types.js';
import { cap, collectPages, newestInstant, sameEmail, windowStart } from './paging.js';
import { jamieMeetingUrl } from './meetings.js';

/**
 * The `tasks` partition of the `jamie` watcher (spec 7.1): the action items
 * Jamie lifted out of a meeting, whoever they fall to.
 *
 * The watcher only observes. Downstream, each item becomes a Notion
 * `create_task` proposal under Dom's name, with a delegate's name in round
 * brackets at the end of the title when the item is not Dom's (ADR 0009).
 * Nothing here writes to Jamie: its REST surface is read-only (ADR 0005).
 */

export const TASKS_PARTITION = 'tasks';

const MAX_TASK_SUMMARY_CHARS = 120;

export type JamieTaskRecord = {
  kind: 'task';
  id: string;
  text: string;
  completed: boolean;
  assigneeName: string | null;
  assigneeEmail: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: string;
  assignedToDom: boolean;
};

function taskOf(raw: unknown): JamieTask {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { id?: unknown }).id !== 'string') {
    throw new Error(
      'jamie tasks could not read an action item: the record carries no string id. ' +
        'Check jamieTaskSchema in packages/connectors/src/jamie/types.ts.',
    );
  }
  return raw as JamieTask;
}

/**
 * One poll of the tasks window. `completed` is left off the request so both
 * open and finished items come back: an item Dom has already ticked off in
 * Jamie still belongs in the ledger, and its completion is a change of hash.
 */
export async function pollTasks(
  reads: Pick<JamieReads, 'listTasks'>,
  cursor: string | null,
  now: string,
): Promise<PollResult> {
  const startDate = windowStart(cursor, now);
  const tasks = await collectPages(TASKS_PARTITION, async (pageCursor) => {
    const page = await reads.listTasks({
      startDate,
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    return { items: page.tasks, nextCursor: page.nextCursor };
  });

  const records: SourceRecord[] = tasks.map((task) => ({
    id: task.id,
    observedAt: task.createdAt,
    raw: task,
  }));

  return {
    records,
    nextCursor: newestInstant(
      tasks.map((task) => task.createdAt),
      cursor,
    ),
  };
}

/** Reduces a Jamie action item to its canonical record and the ledger metadata around it. */
export function normaliseTask(record: SourceRecord, domEmail: string): Observation {
  const task = taskOf(record.raw);
  const assignedToDom = sameEmail(task.assignee?.email, domEmail);

  const canonical: JamieTaskRecord = {
    kind: 'task',
    id: task.id,
    text: task.text,
    completed: task.completed,
    assigneeName: task.assignee?.name ?? null,
    assigneeEmail: task.assignee?.email ?? null,
    meetingId: task.meetingId,
    meetingTitle: task.meetingTitle,
    createdAt: task.createdAt,
    assignedToDom,
  };

  return {
    sourceSystem: 'jamie',
    recordId: task.id,
    observedAt: record.observedAt,
    record: canonical,
    // A meeting's items triage with the meeting they came from, so the
    // planner sees the debrief whole. An item with no meeting stands alone.
    correlationKey: task.meetingId ?? task.id,
    summary: `Jamie task: ${cap(task.text, MAX_TASK_SUMMARY_CHARS)}`,
    labels: ['JamieTask', assignedToDom ? 'AssignedToDom' : 'Delegated'],
    ...(task.meetingId === null ? {} : { url: jamieMeetingUrl(task.meetingId) }),
  };
}
