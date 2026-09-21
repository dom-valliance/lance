import { http, HttpResponse, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/index.js';
import { FakeClock } from '../core/testing.js';
import { createGraphConnector, GRAPH_BASE_URL } from './client.js';
import { createGraphReads, type GraphReads } from './reads.js';
import { graphFixture } from './testing.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const accessToken = (): Promise<string> => Promise.resolve('an-access-token');

const readsOver = (clock?: FakeClock): GraphReads =>
  createGraphReads(
    createGraphConnector({ accessToken, ...(clock === undefined ? {} : { clock }) }),
  );

const json = (name: string): Response =>
  HttpResponse.json(graphFixture<Record<string, unknown>>(name));

describe('listMailFolders', () => {
  it('returns the folders and sends the bearer token', async () => {
    const authorisations: (string | null)[] = [];
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/mailFolders`, ({ request }) => {
        authorisations.push(request.headers.get('authorization'));
        return json('mail-folders');
      }),
    );

    const folders = await readsOver().listMailFolders();

    expect(folders.map((folder) => folder.displayName)).toEqual([
      'Inbox',
      'Sent Items',
      'AI-Filed',
    ]);
    expect(authorisations).toEqual(['Bearer an-access-token']);
  });
});

describe('listCategories', () => {
  it('returns the master categories from the Outlook taxonomy', async () => {
    server.use(http.get(`${GRAPH_BASE_URL}/me/outlook/masterCategories`, () => json('categories')));

    const categories = await readsOver().listCategories();

    expect(categories.map((category) => category.displayName)).toContain('Newsletters');
    expect(categories).toHaveLength(7);
  });
});

describe('getMailboxSettings', () => {
  it('keeps only the time zone and the working hours', async () => {
    server.use(http.get(`${GRAPH_BASE_URL}/me/mailboxSettings`, () => json('mailbox-settings')));

    const settings = await readsOver().getMailboxSettings();

    expect(Object.keys(settings).sort()).toEqual(['timeZone', 'workingHours']);
    expect(settings.timeZone).toBe('GMT Standard Time');
    expect(settings.workingHours?.startTime).toBe('09:00:00.0000000');
  });

  it('asks Graph for only those two fields', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/mailboxSettings`, ({ request }) => {
        urls.push(request.url);
        return json('mailbox-settings');
      }),
    );

    await readsOver().getMailboxSettings();

    expect(urls[0]).toContain('$select=timeZone,workingHours');
  });
});

describe('deltaMessages', () => {
  const handler = (record: { urls: string[]; prefers: (string | null)[] }): RequestHandler =>
    http.get(`${GRAPH_BASE_URL}/me/mailFolders/:folderId/messages/delta`, ({ request }) => {
      record.urls.push(request.url);
      record.prefers.push(request.headers.get('prefer'));
      return new URL(request.url).searchParams.has('$skiptoken')
        ? json('messages-delta-page-2')
        : json('messages-delta-page-1');
    });

  it('follows the next link across two pages and stops at the delta link', async () => {
    const record = { urls: [] as string[], prefers: [] as (string | null)[] };
    server.use(handler(record));

    const result = await readsOver().deltaMessages({ folderId: 'AAMkAGI2-inbox' });

    expect(record.urls).toHaveLength(2);
    expect(result.messages.map((message) => message.id)).toEqual([
      'AAMkAGI2-msg-0001',
      'AAMkAGI2-msg-0002',
      'AAMkAGI2-msg-0003',
    ]);
    expect(result.deltaLink).toContain('$deltatoken=DELTA2');
  });

  it('collects the ids of entries Graph marks as removed', async () => {
    const record = { urls: [] as string[], prefers: [] as (string | null)[] };
    server.use(handler(record));

    const result = await readsOver().deltaMessages({ folderId: 'AAMkAGI2-inbox' });

    expect(result.removed).toEqual(['AAMkAGI2-msg-0000']);
    expect(result.messages.map((message) => message.id)).not.toContain('AAMkAGI2-msg-0000');
  });

  it('selects the documented fields and asks for a text body', async () => {
    const record = { urls: [] as string[], prefers: [] as (string | null)[] };
    server.use(handler(record));

    await readsOver().deltaMessages({ folderId: 'AAMkAGI2-inbox' });

    expect(record.urls[0]).toContain(
      '$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,categories,parentFolderId,bodyPreview,body,internetMessageId,webLink',
    );
    expect(record.prefers).toEqual([
      'outlook.body-content-type="text"',
      'outlook.body-content-type="text"',
    ]);
  });

  it('resumes from a stored delta link rather than resynchronising', async () => {
    const record = { urls: [] as string[], prefers: [] as (string | null)[] };
    server.use(handler(record));

    await readsOver().deltaMessages({
      folderId: 'AAMkAGI2-inbox',
      deltaLink: `${GRAPH_BASE_URL}/me/mailFolders/AAMkAGI2-inbox/messages/delta?$deltatoken=DELTA1&$skiptoken=RESUME`,
    });

    expect(record.urls).toHaveLength(1);
    expect(record.urls[0]).toContain('$deltatoken=DELTA1');
  });
});

describe('deltaCalendarView', () => {
  it('pages the calendar window and separates cancellations from events', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/calendarView/delta`, ({ request }) => {
        urls.push(request.url);
        return new URL(request.url).searchParams.has('$skiptoken')
          ? json('calendar-delta-page-2')
          : json('calendar-delta-page-1');
      }),
    );

    const result = await readsOver().deltaCalendarView({
      start: '2026-09-21T00:00:00Z',
      end: '2026-10-05T00:00:00Z',
    });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('startDateTime=2026-09-21T00%3A00%3A00Z');
    expect(urls[0]).toContain('endDateTime=2026-10-05T00%3A00%3A00Z');
    expect(result.events.map((event) => event.id)).toEqual([
      'AAMkAGI2-evt-0001',
      'AAMkAGI2-evt-0002',
    ]);
    expect(result.removed).toEqual(['AAMkAGI2-evt-0000']);
    expect(result.deltaLink).toContain('$deltatoken=CALDELTA2');
  });
});

describe('getMessage', () => {
  it('returns the whole message for the executor record hash', async () => {
    server.use(http.get(`${GRAPH_BASE_URL}/me/messages/:id`, () => json('message')));

    const message = await readsOver().getMessage('AAMkAGI2-msg-0001');

    expect(message.id).toBe('AAMkAGI2-msg-0001');
    expect(message.internetMessageId).toBe('<0001.renewal@northwind.example.com>');
    expect(message.body?.contentType).toBe('text');
  });
});

describe('the retry policy', () => {
  it('retries once after a 429 and honours Retry-After without sleeping in the test', async () => {
    let calls = 0;
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/mailFolders`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(graphFixture<Record<string, unknown>>('throttled'), {
              status: 429,
              headers: { 'retry-after': '3' },
            })
          : json('mail-folders');
      }),
    );
    const clock = new FakeClock();

    const folders = await readsOver(clock).listMailFolders();

    expect(calls).toBe(2);
    expect(folders).toHaveLength(3);
    expect(clock.sleeps).toEqual([3000]);
  });

  it('does not retry a 401, because a fresh token is the only cure', async () => {
    let calls = 0;
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/mailFolders`, () => {
        calls += 1;
        return HttpResponse.json(graphFixture<Record<string, unknown>>('unauthorised'), {
          status: 401,
        });
      }),
    );
    const clock = new FakeClock();

    const error = (await readsOver(clock)
      .listMailFolders()
      .catch((caught: unknown) => caught)) as ConnectorError;

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(clock.sleeps).toEqual([]);
  });

  it('never repeats the Graph error body in the message', async () => {
    server.use(
      http.get(`${GRAPH_BASE_URL}/me/mailFolders`, () =>
        HttpResponse.json(graphFixture<Record<string, unknown>>('unauthorised'), { status: 401 }),
      ),
    );

    const error = (await readsOver()
      .listMailFolders()
      .catch((caught: unknown) => caught)) as ConnectorError;

    expect(error.message).not.toContain('InvalidAuthenticationToken');
    expect(error.message).toBe('graph listMailFolders: HTTP 401.');
  });
});
