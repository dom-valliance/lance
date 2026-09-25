import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import { createNotionConnector, type NotionConnector } from './client.js';
import {
  getDataSourceSchema,
  getPageText,
  getTask,
  getUser,
  listUsers,
  MAX_QUERY_PAGES,
  queryMeetingsEditedSince,
  queryOpenTasks,
  queryTasksEditedSince,
} from './reads.js';

/** Loads a recorded Notion response. Shape is asserted by the schemas under test. */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../__fixtures__/notion/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

const DATA_SOURCE_ID = '20257534-6e48-81fe-b4b5-000b69ecace6';
const QUERY_URL = `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`;
const PERMITTED = [
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
];

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connector(): NotionConnector {
  return createNotionConnector({ token: 'ntn_test_only', clock: new FakeClock() });
}

describe('queryTasksEditedSince', () => {
  it('filters on last_edited_time after the cursor date, sorted oldest first, 100 a page', async () => {
    let body: unknown;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('query-page-2'));
      }),
    );
    await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-18T00:00:00.000Z',
    });
    expect(body).toEqual({
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { after: '2026-09-18T00:00:00.000Z' },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 100,
    });
  });

  it('keeps to the principal tasks when given their Notion user id', async () => {
    let body: unknown;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('query-page-2'));
      }),
    );
    await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-18T00:00:00.000Z',
      assigneeId: 'a1b2c3d4-0000-4000-8000-000000000001',
    });
    expect(body).toMatchObject({
      filter: {
        and: [
          {
            timestamp: 'last_edited_time',
            last_edited_time: { after: '2026-09-18T00:00:00.000Z' },
          },
          { property: 'Assignee', people: { contains: 'a1b2c3d4-0000-4000-8000-000000000001' } },
        ],
      },
    });
  });

  it('follows next_cursor across two pages and returns the tasks in order', async () => {
    const cursors: (string | undefined)[] = [];
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        const payload = (await request.json()) as { start_cursor?: string };
        cursors.push(payload.start_cursor);
        return HttpResponse.json(
          fixture(payload.start_cursor === undefined ? 'query-page-1' : 'query-page-2'),
        );
      }),
    );
    const result = await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-01T00:00:00.000Z',
    });
    expect(cursors).toEqual([undefined, 'cursor-page-2']);
    expect(result.tasks.map((task) => task.id)).toEqual([
      'aa11bb22-cc33-4dd4-8ee5-ff6600112233',
      'bb22cc33-dd44-4ee5-9ff6-001122334455',
    ]);
    expect(result.cursor).toBeNull();
  });

  it('resumes from a cursor the previous run returned', async () => {
    let seen: string | undefined;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        seen = ((await request.json()) as { start_cursor?: string }).start_cursor;
        return HttpResponse.json(fixture('query-page-2'));
      }),
    );
    await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-01T00:00:00.000Z',
      cursor: 'cursor-page-2',
    });
    expect(seen).toBe('cursor-page-2');
  });
});

describe('queryOpenTasks', () => {
  it('keeps the open sweep to the principal tasks when given their Notion user id', async () => {
    let body: { filter?: { and?: unknown[] } } = {};
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(fixture('query-page-2'));
      }),
    );
    await queryOpenTasks(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      assigneeId: 'a1b2c3d4-0000-4000-8000-000000000001',
    });
    expect(body.filter?.and).toContainEqual({
      property: 'Assignee',
      people: { contains: 'a1b2c3d4-0000-4000-8000-000000000001' },
    });
  });

  it('asks for every task whose Status is not Done, Cancelled or Archived, and follows the paging to the end', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        const payload = (await request.json()) as Record<string, unknown>;
        bodies.push(payload);
        return HttpResponse.json(
          fixture(payload['start_cursor'] === undefined ? 'query-page-1' : 'query-page-2'),
        );
      }),
    );
    const tasks = await queryOpenTasks(connector(), { dataSourceId: DATA_SOURCE_ID });
    expect(bodies[0]).toEqual({
      filter: {
        and: [
          { property: 'Status', status: { does_not_equal: 'Done' } },
          { property: 'Status', status: { does_not_equal: 'Cancelled' } },
          { property: 'Status', status: { does_not_equal: 'Archived' } },
        ],
      },
      page_size: 100,
    });
    expect(bodies[1]?.['start_cursor']).toBe('cursor-page-2');
    expect(tasks.map((task) => task.id)).toEqual([
      'aa11bb22-cc33-4dd4-8ee5-ff6600112233',
      'bb22cc33-dd44-4ee5-9ff6-001122334455',
    ]);
  });
});

describe('getTask', () => {
  it('returns one normalised task record', async () => {
    server.use(
      http.get('https://api.notion.com/v1/pages/aa11bb22-cc33-4dd4-8ee5-ff6600112233', () =>
        HttpResponse.json(fixture('task-page')),
      ),
    );
    const task = await getTask(connector(), 'aa11bb22-cc33-4dd4-8ee5-ff6600112233');
    expect(task.title).toBe('Draft the quarterly plan (Robin Ash)');
    expect(task.status).toBe('In Progress');
  });
});

describe('getDataSourceSchema', () => {
  it('returns every property name and type so the permitted list can be checked', async () => {
    server.use(
      http.get(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, () =>
        HttpResponse.json(fixture('data-source')),
      ),
    );
    const schema = await getDataSourceSchema(connector(), DATA_SOURCE_ID);
    const names = schema.properties.map((property) => property.name);
    for (const permitted of PERMITTED) {
      expect(names).toContain(permitted);
    }
    expect(names).toContain('Completed on');
  });
});

describe('listUsers', () => {
  it('returns each workspace member with an email when Notion exposes one', async () => {
    server.use(
      http.get('https://api.notion.com/v1/users', () => HttpResponse.json(fixture('users'))),
    );
    const users = await listUsers(connector());
    expect(users).toEqual([
      {
        id: '1fdd872b-594c-8146-b22f-00028f1f5a41',
        name: 'Sample Owner',
        email: 'owner@example.test',
      },
      {
        id: '3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40',
        name: 'Robin Ash',
        email: 'robin.ash@example.test',
      },
      { id: '9f2e6d41-5a77-4b88-9c99-1d2e3f405162', name: 'Lance' },
    ]);
  });
});

describe('getUser', () => {
  it('resolves one user by id', async () => {
    server.use(
      http.get('https://api.notion.com/v1/users/3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40', () =>
        HttpResponse.json(fixture('user')),
      ),
    );
    const user = await getUser(connector(), '3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40');
    expect(user.name).toBe('Robin Ash');
  });
});

describe('the paging cap', () => {
  it('tells the operator to share the database when Notion answers 404', async () => {
    server.use(
      http.post(QUERY_URL, () =>
        HttpResponse.json(
          { object: 'error', status: 404, code: 'object_not_found', message: 'secret detail' },
          { status: 404 },
        ),
      ),
    );
    const error = (await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-01T00:00:00.000Z',
    }).catch((e: unknown) => e)) as ConnectorError;
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('shared with the integration');
    expect(error.message).not.toContain('secret detail');
  });

  it('stops a task query that never converges and says what to do', async () => {
    let pages = 0;
    server.use(
      http.post(QUERY_URL, () => {
        pages += 1;
        return HttpResponse.json({
          object: 'list',
          results: [],
          next_cursor: `cursor-${pages}`,
          has_more: true,
        });
      }),
    );
    const error = (await queryTasksEditedSince(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      since: '2026-09-18T00:00:00.000Z',
    }).catch((caught: unknown) => caught)) as ConnectorError;
    expect(pages).toBe(MAX_QUERY_PAGES);
    expect(error.message).toContain(`within ${MAX_QUERY_PAGES} pages`);
    expect(error.message).toContain('Narrow the window');
    expect(error.retryable).toBe(false);
  });

  it('stops a member listing that never converges', async () => {
    let pages = 0;
    server.use(
      http.get('https://api.notion.com/v1/users', () => {
        pages += 1;
        return HttpResponse.json({
          object: 'list',
          results: [],
          next_cursor: `cursor-${pages}`,
          has_more: true,
        });
      }),
    );
    const error = (await listUsers(connector()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(pages).toBe(MAX_QUERY_PAGES);
    expect(error.message).toContain(`within ${MAX_QUERY_PAGES} pages`);
    expect(error.message).toContain('Check the Notion workspace member count');
  });
});

const MEETINGS_DATA_SOURCE_ID = '1fc57534-6e48-804e-a193-000bec4176ab';
const MEETINGS_QUERY_URL = `https://api.notion.com/v1/data_sources/${MEETINGS_DATA_SOURCE_ID}/query`;
const MEETING_PAGE_ID = 'cc33dd44-ee55-4ff6-8a07-112233445566';
const BLOCKS_URL = `https://api.notion.com/v1/blocks/${MEETING_PAGE_ID}/children`;

/** A synthetic Meetings row. No real names, addresses or page ids appear here. */
function meetingPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'page',
    id: MEETING_PAGE_ID,
    url: `https://www.notion.so/Pilot-review-${MEETING_PAGE_ID.replace(/-/g, '')}`,
    created_time: '2026-09-15T08:00:00.000Z',
    last_edited_time: '2026-09-21T09:30:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Pilot review' }] },
      Attendees: {
        type: 'people',
        people: [{ id: '1fdd872b-594c-8146-b22f-00028f1f5a41' }],
      },
      Owner: { type: 'people', people: [{ id: '1fdd872b-594c-8146-b22f-00028f1f5a41' }] },
      Type: { type: 'select', select: { name: 'Client Meeting' } },
      'Event time': {
        type: 'date',
        date: { start: '2026-09-21T09:00:00.000Z', end: '2026-09-21T10:00:00.000Z' },
      },
      Date: { type: 'date', date: { start: '2026-09-21' } },
      Summary: { type: 'rich_text', rich_text: [{ plain_text: 'Agreed the pilot scope.' }] },
      'AI summary': { type: 'rich_text', rich_text: [{ plain_text: 'Scope agreed.' }] },
      'Attendees 1': { type: 'rich_text', rich_text: [{ plain_text: 'Sample Counterparty' }] },
      Projects: { type: 'relation', relation: [{ id: '5c9e2a71-8d3b-4c6f-9a10-2b3c4d5e6f70' }] },
      'Accounts (Clients)': {
        type: 'relation',
        relation: [{ id: '8f2b5d04-b06e-4f92-ad43-5e6f70819203' }],
      },
      'Thread Tag': { type: 'multi_select', multi_select: [{ name: 'Pilot' }] },
      'Thread Session': { type: 'relation', relation: [] },
    },
    ...overrides,
  };
}

function meetingList(
  results: Record<string, unknown>[],
  nextCursor: string | null,
): Record<string, unknown> {
  return { object: 'list', results, next_cursor: nextCursor, has_more: nextCursor !== null };
}

function textBlock(id: string, type: string, text: string): Record<string, unknown> {
  return {
    object: 'block',
    id,
    type,
    has_children: false,
    [type]: { rich_text: [{ plain_text: text }] },
  };
}

function blockList(
  results: Record<string, unknown>[],
  nextCursor: string | null = null,
): Record<string, unknown> {
  return { object: 'list', results, next_cursor: nextCursor, has_more: nextCursor !== null };
}

describe('queryMeetingsEditedSince', () => {
  it('queries the Meetings data source on last_edited_time, oldest edit first', async () => {
    let body: unknown;
    server.use(
      http.post(MEETINGS_QUERY_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(meetingList([], null));
      }),
    );
    await queryMeetingsEditedSince(connector(), {
      dataSourceId: MEETINGS_DATA_SOURCE_ID,
      since: '2026-09-20T00:00:00.000Z',
    });
    expect(body).toEqual({
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { after: '2026-09-20T00:00:00.000Z' },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 100,
    });
  });

  it('normalises every property the Meetings DB carries', async () => {
    server.use(
      http.post(MEETINGS_QUERY_URL, () => HttpResponse.json(meetingList([meetingPage()], null))),
    );
    const result = await queryMeetingsEditedSince(connector(), {
      dataSourceId: MEETINGS_DATA_SOURCE_ID,
      since: '2026-09-20T00:00:00.000Z',
    });
    expect(result.meetings).toEqual([
      {
        id: MEETING_PAGE_ID,
        url: `https://www.notion.so/Pilot-review-${MEETING_PAGE_ID.replace(/-/g, '')}`,
        name: 'Pilot review',
        attendeeIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
        ownerIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
        type: 'Client Meeting',
        eventTimeStart: '2026-09-21T09:00:00.000Z',
        eventTimeEnd: '2026-09-21T10:00:00.000Z',
        date: '2026-09-21',
        summary: 'Agreed the pilot scope.',
        aiSummary: 'Scope agreed.',
        attendeeNames: 'Sample Counterparty',
        projectIds: ['5c9e2a71-8d3b-4c6f-9a10-2b3c4d5e6f70'],
        accountIds: ['8f2b5d04-b06e-4f92-ad43-5e6f70819203'],
        threadTags: ['Pilot'],
        threadSessionIds: [],
        createdTime: '2026-09-15T08:00:00.000Z',
        lastEditedTime: '2026-09-21T09:30:00.000Z',
      },
    ]);
    expect(result.cursor).toBeNull();
  });

  it('follows next_cursor to the end of the window', async () => {
    const cursors: (string | undefined)[] = [];
    server.use(
      http.post(MEETINGS_QUERY_URL, async ({ request }) => {
        const payload = (await request.json()) as { start_cursor?: string };
        cursors.push(payload.start_cursor);
        return payload.start_cursor === undefined
          ? HttpResponse.json(meetingList([meetingPage()], 'cursor-meetings-2'))
          : HttpResponse.json(
              meetingList([meetingPage({ id: 'dd44ee55-ff66-4a07-8b18-223344556677' })], null),
            );
      }),
    );
    const result = await queryMeetingsEditedSince(connector(), {
      dataSourceId: MEETINGS_DATA_SOURCE_ID,
      since: '2026-09-01T00:00:00.000Z',
    });
    expect(cursors).toEqual([undefined, 'cursor-meetings-2']);
    expect(result.meetings.map((meeting) => meeting.id)).toEqual([
      MEETING_PAGE_ID,
      'dd44ee55-ff66-4a07-8b18-223344556677',
    ]);
  });

  it('stops a meetings query that never converges', async () => {
    let pages = 0;
    server.use(
      http.post(MEETINGS_QUERY_URL, () => {
        pages += 1;
        return HttpResponse.json(meetingList([], `cursor-${pages}`));
      }),
    );
    const error = (await queryMeetingsEditedSince(connector(), {
      dataSourceId: MEETINGS_DATA_SOURCE_ID,
      since: '2026-09-01T00:00:00.000Z',
    }).catch((caught: unknown) => caught)) as ConnectorError;
    expect(pages).toBe(MAX_QUERY_PAGES);
    expect(error.message).toContain('queryMeetingsEditedSince');
  });
});

describe('getPageText', () => {
  it('joins the text of paragraphs, headings, list items, to-dos and quotes', async () => {
    server.use(
      http.get(BLOCKS_URL, () =>
        HttpResponse.json(
          blockList([
            textBlock('b1', 'heading_2', 'Decisions'),
            textBlock('b2', 'paragraph', 'The pilot starts in October.'),
            textBlock('b3', 'bulleted_list_item', 'Confirm the scope'),
            textBlock('b4', 'numbered_list_item', 'Send the summary'),
            textBlock('b5', 'to_do', 'Book the follow-up'),
            textBlock('b6', 'quote', 'We are happy to proceed.'),
          ]),
        ),
      ),
    );
    expect(await getPageText(connector(), MEETING_PAGE_ID)).toBe(
      [
        'Decisions',
        'The pilot starts in October.',
        'Confirm the scope',
        'Send the summary',
        'Book the follow-up',
        'We are happy to proceed.',
      ].join('\n'),
    );
  });

  it('skips a block type it cannot read rather than failing the read', async () => {
    server.use(
      http.get(BLOCKS_URL, () =>
        HttpResponse.json(
          blockList([
            { object: 'block', id: 'b1', type: 'meeting_notes_ai_summary', has_children: false },
            { object: 'block', id: 'b2', type: 'image', image: { type: 'external' } },
            { object: 'block', id: 'b3', type: 'divider', divider: {} },
            textBlock('b4', 'paragraph', 'The only readable line.'),
            { object: 'block', id: 'b5', type: 'paragraph', paragraph: { colour: 'default' } },
          ]),
        ),
      ),
    );
    expect(await getPageText(connector(), MEETING_PAGE_ID)).toBe('The only readable line.');
  });

  it('pages through the children and stops once maxBlocks is reached', async () => {
    const sizes: (string | null)[] = [];
    server.use(
      http.get(BLOCKS_URL, ({ request }) => {
        const url = new URL(request.url);
        sizes.push(url.searchParams.get('page_size'));
        return url.searchParams.get('start_cursor') === null
          ? HttpResponse.json(blockList([textBlock('b1', 'paragraph', 'First')], 'cursor-blocks-2'))
          : HttpResponse.json(blockList([textBlock('b2', 'paragraph', 'Second')]));
      }),
    );
    expect(await getPageText(connector(), MEETING_PAGE_ID, { maxBlocks: 2 })).toBe('First\nSecond');
    expect(sizes).toEqual(['2', '1']);
  });
});
