import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fromNotionDataSource,
  fromNotionPage,
  fromNotionUser,
  notionDataSourceSchema,
  notionPageSchema,
  notionUserSchema,
  TASK_PROPERTY_NAMES,
} from './types.js';

/** Loads a recorded Notion response. Shape is asserted by the schemas under test. */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../__fixtures__/notion/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

describe('fromNotionPage', () => {
  it('maps every permitted property of a populated page to plain values', () => {
    const page = notionPageSchema.parse(fixture('task-page'));
    expect(fromNotionPage(page)).toEqual({
      id: 'aa11bb22-cc33-4dd4-8ee5-ff6600112233',
      url: 'https://www.notion.so/Draft-the-quarterly-plan-aa11bb22cc334dd48ee5ff6600112233',
      title: 'Draft the quarterly plan (Robin Ash)',
      status: 'In Progress',
      assigneeIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
      contributorIds: ['3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40'],
      due: '2026-10-03',
      priority: 'High',
      projectIds: ['5c9e2a71-8d3b-4c6f-9a10-2b3c4d5e6f70'],
      typeIds: ['6d0f3b82-9e4c-4d70-8b21-3c4d5e6f7081', '7e1a4c93-af5d-4e81-9c32-4d5e6f708192'],
      subTypes: ['Internal', 'Deliverables'],
      description: 'Collect the numbers, then write the one-pager.',
      notes: 'Raised in the Monday review.',
      lastEditedTime: '2026-09-18T16:42:00.000Z',
    });
  });

  it('maps an empty property to null, an empty list or an empty string', () => {
    const page = notionPageSchema.parse(fixture('task-page-empty'));
    expect(fromNotionPage(page)).toEqual({
      id: 'bb22cc33-dd44-4ee5-9ff6-001122334455',
      url: 'https://www.notion.so/bb22cc33dd444ee59ff6001122334455',
      title: '',
      status: null,
      assigneeIds: [],
      contributorIds: [],
      due: null,
      priority: null,
      projectIds: [],
      typeIds: [],
      subTypes: [],
      description: '',
      notes: '',
      lastEditedTime: '2026-09-19T07:30:00.000Z',
    });
  });

  it('ignores properties Lance may not write', () => {
    const page = notionPageSchema.parse(fixture('task-page'));
    expect(Object.keys(page.properties)).not.toContain('Hubspot Task ID');
    expect(Object.keys(page.properties)).not.toContain('Completed on');
    expect(Object.keys(page.properties)).not.toContain('Delegate to Ian');
  });

  it('falls back to empty values when a property is missing from the page', () => {
    const page = notionPageSchema.parse({
      object: 'page',
      id: 'ff66-0011',
      url: 'https://www.notion.so/ff660011',
      created_time: '2026-09-01T00:00:00.000Z',
      last_edited_time: '2026-09-02T00:00:00.000Z',
      properties: {},
    });
    const task = fromNotionPage(page);
    expect(task.title).toBe('');
    expect(task.status).toBeNull();
    expect(task.subTypes).toEqual([]);
  });
});

describe('TASK_PROPERTY_NAMES', () => {
  it('names the eleven properties ADR 0009 permits', () => {
    expect(Object.values(TASK_PROPERTY_NAMES)).toEqual([
      'Title',
      'Status',
      'Assignee',
      'Contributors',
      'Due',
      'Priority',
      'Project',
      'Type',
      'Sub-type',
      'Description',
      'Notes',
    ]);
  });
});

describe('fromNotionUser', () => {
  it('keeps the email only when the workspace exposes one', () => {
    expect(fromNotionUser(notionUserSchema.parse(fixture('user')))).toEqual({
      id: '3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40',
      name: 'Robin Ash',
      email: 'robin.ash@example.test',
    });
    const bot = notionUserSchema.parse({ object: 'user', id: 'bot-1', name: null, type: 'bot' });
    expect(fromNotionUser(bot)).toEqual({ id: 'bot-1', name: null });
  });
});

describe('fromNotionDataSource', () => {
  it('reports the property names and types in one sorted list', () => {
    const schema = fromNotionDataSource(notionDataSourceSchema.parse(fixture('data-source')));
    expect(schema.id).toBe('20257534-6e48-81fe-b4b5-000b69ecace6');
    expect(schema.title).toBe('All Tasks DB');
    expect(schema.properties).toContainEqual({ name: 'Sub-type', type: 'multi_select' });
    expect(schema.properties).toContainEqual({ name: 'Hubspot Task ID', type: 'rich_text' });
    expect(schema.properties.map((property) => property.name)).toEqual(
      [...schema.properties.map((property) => property.name)].sort(),
    );
  });
});
