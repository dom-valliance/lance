import { describe, expect, it } from 'vitest';
import {
  isNotionTaskDone,
  isTaskPayload,
  NOTION_CLOSED_STATUSES,
  toTaskView,
  toTaskViews,
  UNKNOWN_STATUS,
  type ObservationRecord,
} from './view.js';

const DOM_NOTION_USER_ID = '1fdd872b-594c-8146-b22f-00028f1f5a41';
const options = { domNotionUserId: DOM_NOTION_USER_ID };

const notionRow = (payload: Record<string, unknown> = {}): ObservationRecord => ({
  id: '01K5S9V6QW3SWCCPVB0N0E303A',
  ts: new Date('2026-09-20T08:00:00.000Z'),
  sourceSystem: 'notion',
  sourceRecordId: 'page-1',
  payload: {
    kind: 'task',
    id: 'page-1',
    url: 'https://www.notion.so/page-1',
    title: 'Draft the pilot scope',
    status: 'In Progress',
    assigneeIds: [DOM_NOTION_USER_ID],
    due: '2026-09-25',
    ...payload,
  },
});

const jamieRow = (payload: Record<string, unknown> = {}): ObservationRecord => ({
  id: '01K5S9V6QW3SWCCPVB0N0E303B',
  ts: new Date('2026-09-20T11:30:00.000Z'),
  sourceSystem: 'jamie',
  sourceRecordId: 'task-1',
  payload: {
    kind: 'task',
    id: 'task-1',
    text: 'Send the revised numbers',
    completed: false,
    assigneeName: 'Ann Example',
    assigneeEmail: 'ann@client.test',
    meetingId: 'mt-1',
    meetingTitle: 'Kick-off with Client Ltd',
    createdAt: '2026-09-20T11:30:00.000Z',
    assignedToDom: false,
    url: 'https://app.meetjamie.ai/meetings/mt-1',
    ...payload,
  },
});

describe('isTaskPayload', () => {
  it('accepts a task observation and refuses anything else', () => {
    expect(isTaskPayload({ kind: 'task' })).toBe(true);
    expect(isTaskPayload({ kind: 'meeting' })).toBe(false);
    expect(isTaskPayload(null)).toBe(false);
  });
});

describe('isNotionTaskDone', () => {
  it('treats every closed All Tasks status as done', () => {
    for (const status of NOTION_CLOSED_STATUSES) {
      expect(isNotionTaskDone(status)).toBe(true);
    }
  });

  it('treats a status still in play as open', () => {
    expect(isNotionTaskDone('In Progress')).toBe(false);
  });
});

describe('toTaskView for a Notion task', () => {
  it('maps the All Tasks row onto the page shape', () => {
    expect(toTaskView(notionRow(), options)).toEqual({
      id: 'notion:page-1',
      source: 'notion',
      sourceId: 'page-1',
      title: 'Draft the pilot scope',
      status: 'In Progress',
      done: false,
      due: '2026-09-25',
      assigneeName: null,
      assignedToDom: true,
      url: 'https://www.notion.so/page-1',
      observedAt: '2026-09-20T08:00:00.000Z',
      meetingTitle: null,
    });
  });

  it('marks a row assigned to somebody else as one Dom does not own', () => {
    expect(toTaskView(notionRow({ assigneeIds: ['someone-else'] }), options)?.assignedToDom).toBe(
      false,
    );
  });

  it('reads a page whose status Notion has not set as unknown and open', () => {
    const view = toTaskView(notionRow({ status: null }), options);
    expect(view?.status).toBe(UNKNOWN_STATUS);
    expect(view?.done).toBe(false);
  });

  it('marks a done page as done', () => {
    expect(toTaskView(notionRow({ status: 'Done' }), options)?.done).toBe(true);
  });
});

describe('toTaskView for a Jamie task', () => {
  it('maps the action item onto the page shape with its meeting', () => {
    expect(toTaskView(jamieRow(), options)).toEqual({
      id: 'jamie:task-1',
      source: 'jamie',
      sourceId: 'task-1',
      title: 'Send the revised numbers',
      status: 'open',
      done: false,
      due: null,
      assigneeName: 'Ann Example',
      assignedToDom: false,
      url: 'https://app.meetjamie.ai/meetings/mt-1',
      observedAt: '2026-09-20T11:30:00.000Z',
      meetingTitle: 'Kick-off with Client Ltd',
    });
  });

  it('says completed for an item ticked off in Jamie', () => {
    const view = toTaskView(jamieRow({ completed: true }), options);
    expect(view?.status).toBe('completed');
    expect(view?.done).toBe(true);
  });
});

describe('toTaskViews', () => {
  it('drops an observation that is not a task of a known source', () => {
    const meeting: ObservationRecord = {
      id: '01K5S9V6QW3SWCCPVB0N0E303C',
      ts: new Date('2026-09-20T12:00:00.000Z'),
      sourceSystem: 'jamie',
      sourceRecordId: 'mt-2',
      payload: { kind: 'meeting' },
    };

    expect(toTaskViews([notionRow(), meeting, jamieRow()], options).map((task) => task.id)).toEqual(
      ['notion:page-1', 'jamie:task-1'],
    );
  });
});
