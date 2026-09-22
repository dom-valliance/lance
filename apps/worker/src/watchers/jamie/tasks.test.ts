import type { JamieReads, JamieTask } from '@lance/connectors';
import { hashRecord } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../types.js';
import { normaliseTask, pollTasks, type JamieTaskRecord } from './tasks.js';

const NOW = '2026-09-21T09:00:00.000Z';
const DOM_EMAIL = 'dom@example.test';

type TaskList = Awaited<ReturnType<JamieReads['listTasks']>>;
type ListTasksCall = NonNullable<Parameters<JamieReads['listTasks']>[0]>;

function task(overrides: Partial<JamieTask> = {}): JamieTask {
  return {
    id: 'tsk-1',
    text: 'Send the revised statement of work to Northwind',
    completed: false,
    assignee: { id: 'p-1', name: 'Dom Selvon', email: 'DOM@EXAMPLE.TEST' },
    meetingId: 'mtg-1',
    meetingTitle: 'Northwind pilot debrief',
    createdAt: '2026-09-20T13:46:00.000Z',
    userId: 'usr-1',
    ...overrides,
  };
}

interface FakeTaskReads {
  listCalls: ListTasksCall[];
  listTasks: JamieReads['listTasks'];
}

function fakeReads(pages: TaskList[]): FakeTaskReads {
  const listCalls: ListTasksCall[] = [];
  let page = 0;
  return {
    listCalls,
    listTasks: (args) => {
      listCalls.push(args ?? {});
      const result = pages[Math.min(page, pages.length - 1)] ?? { tasks: [], nextCursor: null };
      page += 1;
      return Promise.resolve(result);
    },
  };
}

function sourceRecord(raw: JamieTask): SourceRecord {
  return { id: raw.id, observedAt: raw.createdAt, raw };
}

describe('pollTasks', () => {
  it('asks for the last fourteen days on the first poll', async () => {
    const reads = fakeReads([{ tasks: [], nextCursor: null }]);
    await pollTasks(reads, null, NOW);
    expect(reads.listCalls[0]).toEqual({ startDate: '2026-09-07T09:00:00.000Z' });
  });

  it('reaches back seventy-two hours behind the cursor on a later poll', async () => {
    const reads = fakeReads([{ tasks: [], nextCursor: null }]);
    await pollTasks(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(reads.listCalls[0]).toEqual({ startDate: '2026-09-17T13:00:00.000Z' });
  });

  it('asks for open and completed items alike', async () => {
    const reads = fakeReads([{ tasks: [], nextCursor: null }]);
    await pollTasks(reads, null, NOW);
    expect(reads.listCalls[0]).not.toHaveProperty('completed');
  });

  it('dates each item by when Jamie created it and advances the cursor to the newest', async () => {
    const reads = fakeReads([
      {
        tasks: [task(), task({ id: 'tsk-2', createdAt: '2026-09-21T07:30:00.000Z' })],
        nextCursor: null,
      },
    ]);
    const result = await pollTasks(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(result.records[0]?.observedAt).toBe('2026-09-20T13:46:00.000Z');
    expect(result.nextCursor).toBe('2026-09-21T07:30:00.000Z');
  });

  it('keeps the previous cursor when the window returns nothing', async () => {
    const reads = fakeReads([{ tasks: [], nextCursor: null }]);
    const result = await pollTasks(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(result.nextCursor).toBe('2026-09-20T13:00:00.000Z');
  });

  it('follows nextCursor to the end of the window', async () => {
    const reads = fakeReads([
      { tasks: [task()], nextCursor: 'page-2' },
      { tasks: [task({ id: 'tsk-2' })], nextCursor: null },
    ]);
    const result = await pollTasks(reads, null, NOW);
    expect(reads.listCalls[1]).toMatchObject({ cursor: 'page-2' });
    expect(result.records.map((record) => record.id)).toEqual(['tsk-1', 'tsk-2']);
  });

  it('fails the poll when the page cap is reached, so the runner counts it', async () => {
    const reads = fakeReads([{ tasks: [task()], nextCursor: 'more' }]);
    await expect(pollTasks(reads, null, NOW)).rejects.toThrow(/50 page cap/);
  });
});

describe('normaliseTask', () => {
  it('reduces the action item to its canonical record', () => {
    const observation = normaliseTask(sourceRecord(task()), DOM_EMAIL);
    const record = observation.record as JamieTaskRecord;
    expect(record).toEqual({
      kind: 'task',
      id: 'tsk-1',
      text: 'Send the revised statement of work to Northwind',
      completed: false,
      assigneeName: 'Dom Selvon',
      assigneeEmail: 'DOM@EXAMPLE.TEST',
      meetingId: 'mtg-1',
      meetingTitle: 'Northwind pilot debrief',
      createdAt: '2026-09-20T13:46:00.000Z',
      assignedToDom: true,
    });
    expect(observation.summary).toBe('Jamie task: Send the revised statement of work to Northwind');
    expect(observation.labels).toEqual(['JamieTask', 'AssignedToDom']);
    expect(observation.url).toBe('https://app.meetjamie.ai/meetings/mtg-1');
  });

  it('matches Dom on his address whatever its case', () => {
    const observation = normaliseTask(sourceRecord(task()), 'DoM@ExAmPlE.TeSt');
    expect((observation.record as JamieTaskRecord).assignedToDom).toBe(true);
  });

  it('labels an item assigned to somebody else as delegated', () => {
    const observation = normaliseTask(
      sourceRecord(
        task({
          assignee: { id: 'p-2', name: 'Ingrid Halvorsen', email: 'ingrid@northwind.example.test' },
        }),
      ),
      DOM_EMAIL,
    );
    const record = observation.record as JamieTaskRecord;
    expect(record.assignedToDom).toBe(false);
    expect(record.assigneeName).toBe('Ingrid Halvorsen');
    expect(observation.labels).toEqual(['JamieTask', 'Delegated']);
  });

  it('treats an unassigned item as not assigned to Dom', () => {
    const observation = normaliseTask(sourceRecord(task({ assignee: null })), DOM_EMAIL);
    const record = observation.record as JamieTaskRecord;
    expect(record.assigneeEmail).toBeNull();
    expect(record.assignedToDom).toBe(false);
  });

  it('correlates an item with the meeting it came from', () => {
    expect(normaliseTask(sourceRecord(task()), DOM_EMAIL).correlationKey).toBe('mtg-1');
  });

  it('correlates an item with no meeting to itself and leaves the link off', () => {
    const observation = normaliseTask(sourceRecord(task({ meetingId: null })), DOM_EMAIL);
    expect(observation.correlationKey).toBe('tsk-1');
    expect(observation.url).toBeUndefined();
  });

  it('caps the summary line at one hundred and twenty characters', () => {
    const observation = normaliseTask(sourceRecord(task({ text: 'a'.repeat(300) })), DOM_EMAIL);
    expect(observation.summary).toBe(`Jamie task: ${'a'.repeat(120)}`);
  });

  it('gives the same record every time the same item is normalised', () => {
    const first = normaliseTask(sourceRecord(task()), DOM_EMAIL);
    const second = normaliseTask(sourceRecord(task()), DOM_EMAIL);
    expect(hashRecord(second.record)).toBe(hashRecord(first.record));
  });

  it('gives a different record once the item is completed', () => {
    const open = normaliseTask(sourceRecord(task()), DOM_EMAIL);
    const done = normaliseTask(sourceRecord(task({ completed: true })), DOM_EMAIL);
    expect(hashRecord(done.record)).not.toBe(hashRecord(open.record));
  });

  it('refuses a record that is not an action item', () => {
    expect(() => normaliseTask({ id: 'tsk-1', observedAt: NOW, raw: null }, DOM_EMAIL)).toThrow(
      /no string id/,
    );
  });
});
