import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/errors.js';
import * as packageRoot from '../index.js';
import { FakeClock } from '../core/testing.js';
import { createNotionConnector, type NotionConnector } from './client.js';
import { notionWrites } from './writes.js';

/** Loads a recorded Notion response. Shape is asserted by the schemas under test. */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../__fixtures__/notion/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

const DATA_SOURCE_ID = '20257534-6e48-81fe-b4b5-000b69ecace6';
const PAGE_ID = 'aa11bb22-cc33-4dd4-8ee5-ff6600112233';
const DOM_USER_ID = '1fdd872b-594c-8146-b22f-00028f1f5a41';
const CONTRIBUTOR_ID = '3b7c1d90-2f44-4a11-9c02-7d5e8a1b6c40';
const PROJECT_ID = '5c9e2a71-8d3b-4c6f-9a10-2b3c4d5e6f70';
const TYPE_ID = '6d0f3b82-9e4c-4d70-8b21-3c4d5e6f7081';
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

describe('notionWrites', () => {
  it('exports create, update and comment and nothing that removes a task', () => {
    expect(Object.keys(notionWrites).sort()).toEqual(['addComment', 'createTask', 'updateTask']);
  });
});

describe('createTask', () => {
  it('posts the data source parent and exactly the permitted property shapes', async () => {
    let body: unknown;
    server.use(
      http.post('https://api.notion.com/v1/pages', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('created-task-page'));
      }),
    );
    const result = await notionWrites.createTask(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      permittedProperties: PERMITTED,
      input: {
        title: 'Send the revised scope (Robin Ash)',
        status: 'Not Started',
        assigneeIds: [DOM_USER_ID],
        contributorIds: [CONTRIBUTOR_ID],
        due: '2026-09-26',
        priority: 'Medium',
        projectIds: [PROJECT_ID],
        typeIds: [TYPE_ID],
        subTypes: ['Client Task'],
        description: 'Rework the scope after the call.',
        notes: 'From the Jamie action items.',
      },
    });
    expect(body).toEqual({
      parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
      properties: {
        Title: { title: [{ text: { content: 'Send the revised scope (Robin Ash)' } }] },
        Status: { status: { name: 'Not Started' } },
        Assignee: { people: [{ id: DOM_USER_ID }] },
        Contributors: { people: [{ id: CONTRIBUTOR_ID }] },
        Due: { date: { start: '2026-09-26' } },
        Priority: { select: { name: 'Medium' } },
        Project: { relation: [{ id: PROJECT_ID }] },
        Type: { relation: [{ id: TYPE_ID }] },
        'Sub-type': { multi_select: [{ name: 'Client Task' }] },
        Description: { rich_text: [{ text: { content: 'Rework the scope after the call.' } }] },
        Notes: { rich_text: [{ text: { content: 'From the Jamie action items.' } }] },
      },
    });
    expect(result).toEqual({
      id: 'cc33dd44-ee55-4ff6-8001-122334455667',
      url: 'https://www.notion.so/Send-the-revised-scope-cc33dd44ee554ff68001122334455667',
    });
  });

  it('sends only the properties the input names, leaving the assignee to the caller', async () => {
    let body: { properties: Record<string, unknown> } | undefined;
    server.use(
      http.post('https://api.notion.com/v1/pages', async ({ request }) => {
        body = (await request.json()) as { properties: Record<string, unknown> };
        return HttpResponse.json(fixture('created-task-page'));
      }),
    );
    await notionWrites.createTask(connector(), {
      dataSourceId: DATA_SOURCE_ID,
      permittedProperties: PERMITTED,
      input: { title: 'Book the room' },
    });
    expect(Object.keys(body?.properties ?? {})).toEqual(['Title']);
  });

  it('rejects an input key outside the permitted list without calling Notion', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.notion.com/v1/pages', () => {
        calls += 1;
        return HttpResponse.json(fixture('created-task-page'));
      }),
    );
    const error = (await notionWrites
      .createTask(connector(), {
        dataSourceId: DATA_SOURCE_ID,
        permittedProperties: PERMITTED,
        input: { title: 'Book the room', 'Hubspot Task ID': '42' },
      })
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toContain('Hubspot Task ID');
    expect(error.message).toContain('ADR 0009');
    expect(error.retryable).toBe(false);
    expect(calls).toBe(0);
  });

  it('rejects a due date that is not YYYY-MM-DD', async () => {
    await expect(
      notionWrites.createTask(connector(), {
        dataSourceId: DATA_SOURCE_ID,
        permittedProperties: PERMITTED,
        input: { title: 'Book the room', due: '26/09/2026' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a status that is not an option on the database', async () => {
    await expect(
      notionWrites.createTask(connector(), {
        dataSourceId: DATA_SOURCE_ID,
        permittedProperties: PERMITTED,
        input: { title: 'Book the room', status: 'Blocked' },
      }),
    ).rejects.toThrow();
  });
});

describe('updateTask', () => {
  it('patches only the properties the caller named', async () => {
    let body: unknown;
    server.use(
      http.patch(`https://api.notion.com/v1/pages/${PAGE_ID}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('updated-task-page'));
      }),
    );
    const result = await notionWrites.updateTask(connector(), {
      pageId: PAGE_ID,
      permittedProperties: PERMITTED,
      patch: { status: 'Done' },
    });
    expect(body).toEqual({ properties: { Status: { status: { name: 'Done' } } } });
    expect(result.id).toBe(PAGE_ID);
  });

  it('refuses Hubspot Task ID before any request', async () => {
    let calls = 0;
    server.use(
      http.patch(`https://api.notion.com/v1/pages/${PAGE_ID}`, () => {
        calls += 1;
        return HttpResponse.json(fixture('updated-task-page'));
      }),
    );
    const error = (await notionWrites
      .updateTask(connector(), {
        pageId: PAGE_ID,
        permittedProperties: PERMITTED,
        patch: { 'Hubspot Task ID': '42' },
      })
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error.message).toContain('"Hubspot Task ID" is read-only to Lance');
    expect(error.message).toContain('ADR 0009');
    expect(calls).toBe(0);
  });

  it('refuses Completed on before any request', async () => {
    let calls = 0;
    server.use(
      http.patch(`https://api.notion.com/v1/pages/${PAGE_ID}`, () => {
        calls += 1;
        return HttpResponse.json(fixture('updated-task-page'));
      }),
    );
    const error = (await notionWrites
      .updateTask(connector(), {
        pageId: PAGE_ID,
        permittedProperties: PERMITTED,
        patch: { 'Completed on': '2026-09-19' },
      })
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error.message).toContain('"Completed on" is read-only to Lance');
    expect(calls).toBe(0);
  });

  it('refuses a property config has removed from the permitted list', async () => {
    const error = (await notionWrites
      .updateTask(connector(), {
        pageId: PAGE_ID,
        permittedProperties: PERMITTED.filter((name) => name !== 'Notes'),
        patch: { notes: 'anything' },
      })
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error.message).toContain('"Notes" is read-only to Lance');
  });

  it('refuses an empty patch', async () => {
    const error = (await notionWrites
      .updateTask(connector(), { pageId: PAGE_ID, permittedProperties: PERMITTED, patch: {} })
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error.message).toContain('the patch is empty');
  });
});

describe('addComment', () => {
  it('posts the text to the page and reports the page it landed on', async () => {
    let body: unknown;
    server.use(
      http.post('https://api.notion.com/v1/comments', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('comment'));
      }),
    );
    const result = await notionWrites.addComment(connector(), {
      pageId: PAGE_ID,
      text: 'Moved to Done after the review.',
    });
    expect(body).toEqual({
      parent: { page_id: PAGE_ID },
      rich_text: [{ text: { content: 'Moved to Done after the review.' } }],
    });
    expect(result).toEqual({
      id: 'dd44ee55-ff66-4001-9223-344556677889',
      url: 'https://www.notion.so/aa11bb22cc334dd48ee5ff6600112233',
    });
  });

  it('rejects empty comment text', async () => {
    await expect(
      notionWrites.addComment(connector(), { pageId: PAGE_ID, text: '   ' }),
    ).rejects.toThrow();
  });
});

describe('the Notion write boundary', () => {
  it('refuses a non-GET on the connector callers hold', async () => {
    /** TypeScript refuses this too; the cast proves the runtime guard is real. */
    const post = { method: 'POST' } as unknown as { method: 'GET' };
    const error = (await connector()
      .send('createTask', '/pages', post)
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('send is read-only and refuses POST');
    expect(error.message).toContain('@lance/connectors/writes');
  });

  it('keeps the send accessor out of the package root', () => {
    expect(Object.keys(packageRoot)).not.toContain('notionSendAccess');
    expect('notionSendAccess' in packageRoot).toBe(false);
  });
});

describe('write retries', () => {
  const failing = (status: number) => {
    let calls = 0;
    const handler = (): Response => {
      calls += 1;
      return new HttpResponse(null, { status });
    };
    return { handler, calls: () => calls };
  };

  it('attempts a task create once when Notion may already have made the page', async () => {
    const attempts = failing(503);
    server.use(http.post('https://api.notion.com/v1/pages', attempts.handler));
    await expect(
      notionWrites.createTask(connector(), {
        dataSourceId: DATA_SOURCE_ID,
        permittedProperties: PERMITTED,
        input: { title: 'Send the revised scope' },
      }),
    ).rejects.toThrow('HTTP 503');
    expect(attempts.calls()).toBe(1);
  });

  it('attempts a comment once, since a repeat would post a second comment', async () => {
    const attempts = failing(503);
    server.use(http.post('https://api.notion.com/v1/comments', attempts.handler));
    await expect(
      notionWrites.addComment(connector(), { pageId: PAGE_ID, text: 'Moved to Done.' }),
    ).rejects.toThrow('HTTP 503');
    expect(attempts.calls()).toBe(1);
  });

  it('retries a task update, which names the page it changes', async () => {
    const attempts = failing(503);
    server.use(http.patch(`https://api.notion.com/v1/pages/${PAGE_ID}`, attempts.handler));
    await expect(
      notionWrites.updateTask(connector(), {
        pageId: PAGE_ID,
        permittedProperties: PERMITTED,
        patch: { status: 'Done' },
      }),
    ).rejects.toThrow('HTTP 503');
    expect(attempts.calls()).toBe(4);
  });

  it('retries a task create when Notion answers 429, which says it refused it', async () => {
    const attempts = failing(429);
    server.use(http.post('https://api.notion.com/v1/pages', attempts.handler));
    await expect(
      notionWrites.createTask(connector(), {
        dataSourceId: DATA_SOURCE_ID,
        permittedProperties: PERMITTED,
        input: { title: 'Send the revised scope' },
      }),
    ).rejects.toThrow('HTTP 429');
    expect(attempts.calls()).toBe(4);
  });
});
