import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import { createNotionConnector, type NotionConnector } from './client.js';
import {
  getDataSourceSchema,
  getTask,
  getUser,
  listUsers,
  MAX_QUERY_PAGES,
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
