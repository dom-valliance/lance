import { describe, expect, it } from 'vitest';
import {
  assigneeText,
  sourceBadgeLabel,
  taskSourceFilterFrom,
  taskSourceSelected,
  taskStatusFilterFrom,
  taskStatusSelected,
  type TaskView,
} from './task-view';

function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task_1',
    source: 'notion',
    sourceId: 'notion_1',
    title: 'Send the revised proposal',
    status: 'Not started',
    done: false,
    due: null,
    assigneeName: null,
    assignedToDom: false,
    url: null,
    observedAt: '2026-09-21T09:00:00.000Z',
    meetingTitle: null,
    ...overrides,
  };
}

describe('sourceBadgeLabel', () => {
  it('shows "Notion" for a notion task', () => {
    expect(sourceBadgeLabel('notion')).toBe('Notion');
  });

  it('shows "Jamie" for a jamie task', () => {
    expect(sourceBadgeLabel('jamie')).toBe('Jamie');
  });
});

describe('assigneeText', () => {
  it('says "you" when the task is assigned to Dom', () => {
    expect(assigneeText(view({ assignedToDom: true, assigneeName: 'Dom Selvon' }))).toBe('you');
  });

  it('shows the assignee name when it is not Dom', () => {
    expect(assigneeText(view({ assigneeName: 'Sam Ellis' }))).toBe('Sam Ellis');
  });

  it('falls back to "unassigned" when the source gave no name', () => {
    expect(assigneeText(view({ assigneeName: null }))).toBe('unassigned');
  });
});

describe('taskSourceSelected / taskSourceFilterFrom', () => {
  it('defaults to "all" when no source is given', () => {
    expect(taskSourceSelected({})).toBe('all');
    expect(taskSourceFilterFrom({})).toBeUndefined();
  });

  it('accepts a recognised source', () => {
    expect(taskSourceSelected({ source: 'jamie' })).toBe('jamie');
    expect(taskSourceFilterFrom({ source: 'jamie' })).toBe('jamie');
  });

  it('falls back to "all" for a source the api would reject', () => {
    expect(taskSourceSelected({ source: 'outlook' })).toBe('all');
    expect(taskSourceFilterFrom({ source: 'outlook' })).toBeUndefined();
  });
});

describe('taskStatusSelected / taskStatusFilterFrom', () => {
  it('defaults the selected status to open', () => {
    expect(taskStatusSelected({})).toBe('open');
    expect(taskStatusFilterFrom({})).toBe('open');
  });

  it('treats "all" as no status filter', () => {
    expect(taskStatusSelected({ status: 'all' })).toBe('all');
    expect(taskStatusFilterFrom({ status: 'all' })).toBeUndefined();
  });

  it('keeps a recognised status', () => {
    expect(taskStatusSelected({ status: 'done' })).toBe('done');
    expect(taskStatusFilterFrom({ status: 'done' })).toBe('done');
  });

  it('falls back to open for an unrecognised status', () => {
    expect(taskStatusSelected({ status: 'archived' })).toBe('open');
    expect(taskStatusFilterFrom({ status: 'archived' })).toBe('open');
  });
});
