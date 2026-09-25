import {
  ConnectorError,
  type MeetingRecord,
  type QueryMeetingsArgs,
  type QueryOpenTasksArgs,
  type QueryTasksArgs,
  type TaskRecord,
} from '@lance/connectors';
import { hashRecord } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../types.js';
import {
  CURSOR_OVERLAP_MS,
  INITIAL_SINCE,
  MAX_NOTES_CHARS,
  MEETING_PARTITION,
  NOTION_SCHEDULES,
  TASK_PARTITION,
  createNotionWatcher,
  type NotionMeetingRecord,
  type NotionTaskRecord,
  type NotionWatcherReads,
} from './index.js';

const NOW = '2026-09-21T09:00:00.000Z';
const TASKS_DATA_SOURCE_ID = '20257534-6e48-81fe-b4b5-000b69ecace6';
const MEETINGS_DATA_SOURCE_ID = '1fc57534-6e48-804e-a193-000bec4176ab';
/** The principal's Notion user, the assignee on `task()`. */
const ASSIGNEE = '1fdd872b-594c-8146-b22f-00028f1f5a41';
const COLLEAGUE = '2aee983c-605d-8257-c33a-00139a2a6b52';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'aa11bb22-cc33-4dd4-8ee5-ff6600112233',
    url: 'https://www.notion.so/aa11bb22cc334dd48ee5ff6600112233',
    title: 'Draft the pilot plan',
    status: 'In Progress',
    assigneeIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
    contributorIds: [],
    due: '2026-09-25',
    priority: 'High',
    projectIds: [],
    typeIds: [],
    subTypes: ['Internal'],
    description: 'Collect the numbers first.',
    notes: '',
    lastEditedTime: '2026-09-21T08:40:00.000Z',
    ...overrides,
  };
}

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: 'cc33dd44-ee55-4ff6-8a07-112233445566',
    url: 'https://www.notion.so/cc33dd44ee554ff68a07112233445566',
    name: 'Pilot review',
    attendeeIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
    ownerIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
    type: 'Client Meeting',
    eventTimeStart: '2026-09-21T09:00:00.000Z',
    eventTimeEnd: '2026-09-21T10:00:00.000Z',
    date: '2026-09-21',
    summary: 'Agreed the pilot scope.',
    aiSummary: '',
    attendeeNames: 'Sample Counterparty',
    projectIds: [],
    accountIds: [],
    threadTags: [],
    threadSessionIds: [],
    createdTime: '2026-09-15T08:00:00.000Z',
    lastEditedTime: '2026-09-21T08:50:00.000Z',
    ...overrides,
  };
}

interface FakeReads extends NotionWatcherReads {
  taskCalls: QueryTasksArgs[];
  openCalls: QueryOpenTasksArgs[];
  meetingCalls: QueryMeetingsArgs[];
  pageTextCalls: string[];
}

function fakeReads(
  result: {
    tasks?: TaskRecord[];
    /** What the open sweep returns; defaults to the edited tasks. */
    open?: TaskRecord[];
    meetings?: MeetingRecord[];
    pageText?: string;
    /** What a single page read returns; a page missing here is one Notion cannot find. */
    pages?: Record<string, TaskRecord>;
  } = {},
): FakeReads {
  const taskCalls: QueryTasksArgs[] = [];
  const openCalls: QueryOpenTasksArgs[] = [];
  const meetingCalls: QueryMeetingsArgs[] = [];
  const pageTextCalls: string[] = [];
  return {
    taskCalls,
    openCalls,
    meetingCalls,
    pageTextCalls,
    queryTasksEditedSince: (args: QueryTasksArgs) => {
      taskCalls.push(args);
      return Promise.resolve({ tasks: result.tasks ?? [], cursor: null });
    },
    queryOpenTasks: (args: QueryOpenTasksArgs) => {
      openCalls.push(args);
      return Promise.resolve(result.open ?? result.tasks ?? []);
    },
    queryMeetingsEditedSince: (args: QueryMeetingsArgs) => {
      meetingCalls.push(args);
      return Promise.resolve({ meetings: result.meetings ?? [], cursor: null });
    },
    getPageText: (pageId: string) => {
      pageTextCalls.push(pageId);
      return Promise.resolve(result.pageText ?? '');
    },
    getTask: (pageId: string) => {
      const page = result.pages?.[pageId];
      return page === undefined
        ? Promise.reject(
            new ConnectorError('notion getTask: HTTP 404', {
              connector: 'notion',
              operation: 'getTask',
              status: 404,
              retryable: false,
            }),
          )
        : Promise.resolve(page);
    },
  };
}

function watcherWith(
  reads: NotionWatcherReads,
  options: { now?: string; knownOpen?: readonly string[] } = {},
) {
  return createNotionWatcher({
    reads,
    tasksDataSourceId: TASKS_DATA_SOURCE_ID,
    meetingsDataSourceId: MEETINGS_DATA_SOURCE_ID,
    assigneeId: ASSIGNEE,
    knownOpenTaskIds: () => Promise.resolve(options.knownOpen ?? []),
    now: () => options.now ?? NOW,
  });
}

describe('createNotionWatcher', () => {
  it('watches the tasks and meetings partitions every fifteen minutes', async () => {
    const watcher = watcherWith(fakeReads());
    expect(watcher.name).toBe('notion');
    expect(watcher.sourceSystem).toBe('notion');
    expect(watcher.schedules).toEqual([...NOTION_SCHEDULES]);
    expect(await watcher.partitions()).toEqual([TASK_PARTITION, MEETING_PARTITION]);
    expect(watcher.triage).toBe(false);
  });

  it('watches only the tasks partition when no meetings data source is configured', async () => {
    const reads = fakeReads();
    const watcher = createNotionWatcher({
      reads,
      tasksDataSourceId: TASKS_DATA_SOURCE_ID,
      meetingsDataSourceId: null,
      assigneeId: ASSIGNEE,
      knownOpenTaskIds: () => Promise.resolve([]),
      now: () => NOW,
    });
    expect(await watcher.partitions()).toEqual([TASK_PARTITION]);
    await expect(watcher.poll(MEETING_PARTITION, null)).rejects.toThrow(/stale cursor row/);
    expect(reads.meetingCalls).toEqual([]);
  });

  it('reads the whole database when the partition has no cursor yet', async () => {
    const reads = fakeReads();
    await watcherWith(reads).poll(TASK_PARTITION, null);
    expect(reads.taskCalls).toEqual([
      { dataSourceId: TASKS_DATA_SOURCE_ID, since: INITIAL_SINCE, assigneeId: ASSIGNEE },
    ]);
  });

  it('reaches two minutes behind the cursor to cover clock skew', async () => {
    const reads = fakeReads();
    await watcherWith(reads).poll(MEETING_PARTITION, '2026-09-21T08:50:00.000Z');
    expect(reads.meetingCalls[0]).toEqual({
      dataSourceId: MEETINGS_DATA_SOURCE_ID,
      since: new Date(Date.parse('2026-09-21T08:50:00.000Z') - CURSOR_OVERLAP_MS).toISOString(),
    });
  });

  it('returns two edited pages newest last and advances the cursor to the newest edit', async () => {
    const newest = task({
      id: 'bb22cc33-dd44-4ee5-9ff6-001122334455',
      lastEditedTime: '2026-09-21T08:45:00.000Z',
    });
    const oldest = task({ lastEditedTime: '2026-09-21T08:40:00.000Z' });
    const result = await watcherWith(fakeReads({ tasks: [newest, oldest] })).poll(
      TASK_PARTITION,
      '2026-09-21T08:00:00.000Z',
    );
    expect(result.records.map((record) => record.id)).toEqual([oldest.id, newest.id]);
    expect(result.records.map((record) => record.observedAt)).toEqual([
      '2026-09-21T08:40:00.000Z',
      '2026-09-21T08:45:00.000Z',
    ]);
    expect(result.nextCursor).toBe('2026-09-21T08:45:00.000Z');
  });

  it('leaves the cursor alone when nothing was edited', async () => {
    const result = await watcherWith(fakeReads()).poll(TASK_PARTITION, '2026-09-21T08:00:00.000Z');
    expect(result.records).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('refuses a partition it does not watch and says to remove the cursor row', async () => {
    await expect(watcherWith(fakeReads()).poll('projects', null)).rejects.toThrow(
      'Remove the stale cursor row',
    );
  });
});

describe('the removal sweep', () => {
  const GONE = 'dd44ee55-ff66-4a07-8b18-223344556677';
  const STILL_OPEN = 'ee55ff66-0a17-4b28-9c39-334455667788';

  it('does not read the open tasks when the ledger knows no open task yet', async () => {
    const reads = fakeReads();
    await watcherWith(reads).poll(TASK_PARTITION, null);
    expect(reads.openCalls).toEqual([]);
  });

  it('records a removal, dated by the poll, for a known open task Notion no longer returns', async () => {
    const reads = fakeReads({ tasks: [], open: [task({ id: STILL_OPEN })] });
    const result = await watcherWith(reads, { knownOpen: [STILL_OPEN, GONE] }).poll(
      TASK_PARTITION,
      '2026-09-21T08:00:00.000Z',
    );
    expect(reads.openCalls).toEqual([{ dataSourceId: TASKS_DATA_SOURCE_ID, assigneeId: ASSIGNEE }]);
    expect(result.records).toEqual([
      { id: GONE, observedAt: NOW, raw: { id: GONE }, removed: true },
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('treats a task reassigned to someone else as leaving the principal view, not deleted', async () => {
    const reads = fakeReads({
      tasks: [],
      open: [],
      pages: { [GONE]: task({ id: GONE, assigneeIds: [COLLEAGUE] }) },
    });
    const watcher = watcherWith(reads, { knownOpen: [GONE] });

    const result = await watcher.poll(TASK_PARTITION, '2026-09-21T08:00:00.000Z');
    const record = result.records[0];
    if (record === undefined) throw new Error('the sweep returned no record');
    const observation = await watcher.normalise(record, TASK_PARTITION);

    expect(result.records).toEqual([
      { id: GONE, observedAt: NOW, raw: { id: GONE, reassigned: true }, removed: true },
    ]);
    expect(observation.record).toEqual({ kind: 'task', id: GONE, removed: true, reassigned: true });
    expect(observation.labels).toEqual(['Notion', 'Task', 'Reassigned']);
    expect(observation.summary).toBe('Task reassigned to someone else in Notion');
  });

  it('records a removal for a task that still names the principal but neither query returned, which is in the trash', async () => {
    const reads = fakeReads({ tasks: [], open: [], pages: { [GONE]: task({ id: GONE }) } });

    const result = await watcherWith(reads, { knownOpen: [GONE] }).poll(
      TASK_PARTITION,
      '2026-09-21T08:00:00.000Z',
    );

    expect(result.records).toEqual([
      { id: GONE, observedAt: NOW, raw: { id: GONE }, removed: true },
    ]);
  });

  it('does not report a task removed when the same poll saw it edited', async () => {
    const closed = task({ id: GONE, status: 'Done' });
    const reads = fakeReads({ tasks: [closed], open: [] });
    const result = await watcherWith(reads, { knownOpen: [GONE] }).poll(
      TASK_PARTITION,
      '2026-09-21T08:00:00.000Z',
    );
    expect(result.records.map((record) => [record.id, record.removed === true])).toEqual([
      [GONE, false],
    ]);
  });

  it('normalises a removal into a task record that says only that the page is gone', async () => {
    const watcher = watcherWith(fakeReads());
    const observation = await watcher.normalise(
      { id: GONE, observedAt: NOW, raw: { id: GONE }, removed: true },
      TASK_PARTITION,
    );
    expect(observation.sourceSystem).toBe('notion');
    expect(observation.recordId).toBe(GONE);
    expect(observation.correlationKey).toBe(GONE);
    expect(observation.observedAt).toBe(NOW);
    expect(observation.record).toEqual({ kind: 'task', id: GONE, removed: true });
    expect(observation.labels).toEqual(['Notion', 'Task', 'Removed']);
    expect(observation.summary).toBe('Task removed from Notion');
  });
});

describe('normalising a task page', () => {
  it('records the task fields, a Notion and Task label, and the page url', async () => {
    const watcher = watcherWith(fakeReads({ tasks: [task()] }));
    const polled = await watcher.poll(TASK_PARTITION, null);
    const record = polled.records[0];
    if (record === undefined) throw new Error('the poll returned no record');
    const observation = await watcher.normalise(record, TASK_PARTITION);
    expect(observation.sourceSystem).toBe('notion');
    expect(observation.recordId).toBe(task().id);
    expect(observation.correlationKey).toBe(task().id);
    expect(observation.observedAt).toBe('2026-09-21T08:40:00.000Z');
    expect(observation.summary).toBe('Task: Draft the pilot plan');
    expect(observation.labels).toEqual(['Notion', 'Task']);
    expect(observation.url).toBe(task().url);
    const canonical = observation.record as NotionTaskRecord;
    expect(canonical.kind).toBe('task');
    expect(canonical.status).toBe('In Progress');
  });

  it('leaves the last edited time out of the record, so a no-op edit is not a new observation', async () => {
    const watcher = watcherWith(fakeReads());
    const first = await watcher.normalise(
      { id: task().id, observedAt: task().lastEditedTime, raw: task() },
      TASK_PARTITION,
    );
    const touched = await watcher.normalise(
      {
        id: task().id,
        observedAt: '2026-09-21T08:59:00.000Z',
        raw: task({ lastEditedTime: '2026-09-21T08:59:00.000Z' }),
      },
      TASK_PARTITION,
    );
    expect(Object.keys(first.record)).not.toContain('lastEditedTime');
    expect(hashRecord(touched.record)).toBe(hashRecord(first.record));
  });

  it('is hash stable when the same page is normalised twice', async () => {
    const watcher = watcherWith(fakeReads());
    const source: SourceRecord = { id: task().id, observedAt: task().lastEditedTime, raw: task() };
    const first = await watcher.normalise(source, TASK_PARTITION);
    const second = await watcher.normalise(source, TASK_PARTITION);
    expect(second.record).toEqual(first.record);
    expect(hashRecord(second.record)).toBe(hashRecord(first.record));
  });
});

describe('normalising a meeting page', () => {
  function meetingSource(overrides: Partial<MeetingRecord> = {}): SourceRecord {
    const page = meeting(overrides);
    return { id: page.id, observedAt: page.lastEditedTime, raw: page };
  }

  it('summarises the meeting by name and event time start, labelled Notion and Meeting', async () => {
    const reads = fakeReads({ pageText: 'Decisions\nThe pilot starts in October.' });
    const observation = await watcherWith(reads).normalise(meetingSource(), MEETING_PARTITION);
    expect(observation.summary).toBe('Meeting: Pilot review (2026-09-21T09:00:00.000Z)');
    expect(observation.labels).toEqual(['Notion', 'Meeting']);
    expect(observation.correlationKey).toBe(meeting().id);
    expect(observation.url).toBe(meeting().url);
  });

  it('carries the page text as notes when the page was edited in the last day', async () => {
    const reads = fakeReads({ pageText: 'Decisions\nThe pilot starts in October.' });
    const observation = await watcherWith(reads).normalise(meetingSource(), MEETING_PARTITION);
    const canonical = observation.record as NotionMeetingRecord;
    expect(reads.pageTextCalls).toEqual([meeting().id]);
    expect(canonical.notes).toBe('Decisions\nThe pilot starts in October.');
    expect(canonical.notesTruncated).toBe(false);
  });

  it('caps the notes at twenty thousand characters and says the cap was reached', async () => {
    const reads = fakeReads({ pageText: 'x'.repeat(MAX_NOTES_CHARS + 500) });
    const observation = await watcherWith(reads).normalise(meetingSource(), MEETING_PARTITION);
    const canonical = observation.record as NotionMeetingRecord;
    expect(canonical.notes).toHaveLength(MAX_NOTES_CHARS);
    expect(canonical.notesTruncated).toBe(true);
  });

  it('reads no page text for a meeting edited more than a day ago', async () => {
    const reads = fakeReads({ pageText: 'Should never be read' });
    const observation = await watcherWith(reads).normalise(
      meetingSource({ lastEditedTime: '2026-09-18T08:50:00.000Z' }),
      MEETING_PARTITION,
    );
    const canonical = observation.record as NotionMeetingRecord;
    expect(reads.pageTextCalls).toEqual([]);
    expect(canonical.notes).toBeUndefined();
    expect(canonical.notesTruncated).toBeUndefined();
  });

  it('is hash stable when the same meeting is normalised twice', async () => {
    const reads = fakeReads({ pageText: 'Decisions' });
    const watcher = watcherWith(reads);
    const source = meetingSource();
    const first = await watcher.normalise(source, MEETING_PARTITION);
    const second = await watcher.normalise(source, MEETING_PARTITION);
    expect(second.record).toEqual(first.record);
    expect(hashRecord(second.record)).toBe(hashRecord(first.record));
  });
});
