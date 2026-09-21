import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGraphConnector, GRAPH_BASE_URL, type GraphConnector } from './client.js';
import { graphFixture } from './testing.js';
import { graphWrites } from './writes.js';

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

const graph = (): GraphConnector =>
  createGraphConnector({ accessToken: () => Promise.resolve('an-access-token') });

const json = (name: string): Response =>
  HttpResponse.json(graphFixture<Record<string, unknown>>(name));

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

const record = (sent: Sent[]) =>
  async function capture({ request }: { request: Request }): Promise<Sent> {
    const entry: Sent = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.json(),
    };
    sent.push(entry);
    return entry;
  };

describe('the set of Graph writes', () => {
  it('is exactly the five of spec 8', () => {
    expect(Object.keys(graphWrites).sort()).toEqual([
      'applyCategories',
      'createDraft',
      'createEvent',
      'createReplyDraft',
      'moveMessage',
    ]);
  });

  it('offers nothing that sends, deletes or replies to all', () => {
    const names = Object.keys(graphWrites).join(' ');
    expect(names).not.toMatch(/send/i);
    expect(names).not.toMatch(/delete/i);
    expect(names).not.toMatch(/replyall/i);
  });
});

describe('createDraft', () => {
  it('posts a text draft with the recipients Graph expects', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.post(`${GRAPH_BASE_URL}/me/messages`, async (info) => {
        await capture(info);
        return json('draft-created');
      }),
    );

    const result = await graphWrites.createDraft(graph(), {
      subject: 'Renewal terms, as discussed',
      bodyText: 'Attaching the revised schedule.',
      to: ['priya.raman@northwind.example.com'],
      cc: ['ola.bergstrom@example.com'],
    });

    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/v1.0/me/messages',
        body: {
          subject: 'Renewal terms, as discussed',
          body: { contentType: 'text', content: 'Attaching the revised schedule.' },
          toRecipients: [{ emailAddress: { address: 'priya.raman@northwind.example.com' } }],
          ccRecipients: [{ emailAddress: { address: 'ola.bergstrom@example.com' } }],
        },
      },
    ]);
    expect(result).toEqual({
      id: 'AAMkAGI2-draft-0101',
      webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2-draft-0101',
    });
  });

  it('leaves ccRecipients out when there is no copy list', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.post(`${GRAPH_BASE_URL}/me/messages`, async (info) => {
        await capture(info);
        return json('draft-created');
      }),
    );

    await graphWrites.createDraft(graph(), {
      subject: 'A note',
      bodyText: 'Short.',
      to: ['priya.raman@northwind.example.com'],
    });

    expect(sent[0]?.body).not.toHaveProperty('ccRecipients');
  });
});

describe('createReplyDraft', () => {
  it('creates the reply then patches its body with the comment', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.post(`${GRAPH_BASE_URL}/me/messages/:id/createReply`, async (info) => {
        await capture(info);
        return json('reply-draft-created');
      }),
      http.patch(`${GRAPH_BASE_URL}/me/messages/:id`, async (info) => {
        await capture(info);
        return json('reply-draft-patched');
      }),
    );

    const result = await graphWrites.createReplyDraft(graph(), {
      messageId: 'AAMkAGI2-msg-0001',
      comment: 'Happy with these terms. Signing this afternoon.',
    });

    expect(sent).toEqual([
      { method: 'POST', path: '/v1.0/me/messages/AAMkAGI2-msg-0001/createReply', body: {} },
      {
        method: 'PATCH',
        path: '/v1.0/me/messages/AAMkAGI2-draft-0202',
        body: {
          body: {
            contentType: 'text',
            content: 'Happy with these terms. Signing this afternoon.',
          },
        },
      },
    ]);
    expect(result.id).toBe('AAMkAGI2-draft-0202');
  });
});

describe('applyCategories', () => {
  it('patches the whole category list onto the message', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.patch(`${GRAPH_BASE_URL}/me/messages/:id`, async (info) => {
        await capture(info);
        return json('message-categorised');
      }),
    );

    const result = await graphWrites.applyCategories(graph(), {
      messageId: 'AAMkAGI2-msg-0001',
      categories: ['Deals', 'Action'],
    });

    expect(sent).toEqual([
      {
        method: 'PATCH',
        path: '/v1.0/me/messages/AAMkAGI2-msg-0001',
        body: { categories: ['Deals', 'Action'] },
      },
    ]);
    expect(result.id).toBe('AAMkAGI2-msg-0001');
  });
});

describe('moveMessage', () => {
  it('posts the destination folder and returns the message under its new id', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.post(`${GRAPH_BASE_URL}/me/messages/:id/move`, async (info) => {
        await capture(info);
        return json('message-moved');
      }),
    );

    const result = await graphWrites.moveMessage(graph(), {
      messageId: 'AAMkAGI2-msg-0002',
      destinationFolderId: 'AAMkAGI2-ai-filed',
    });

    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/v1.0/me/messages/AAMkAGI2-msg-0002/move',
        body: { destinationId: 'AAMkAGI2-ai-filed' },
      },
    ]);
    expect(result.id).toBe('AAMkAGI2-msg-0002-moved');
  });
});

describe('createEvent', () => {
  it('creates a busy hold with no reminder by default', async () => {
    const sent: Sent[] = [];
    const capture = record(sent);
    server.use(
      http.post(`${GRAPH_BASE_URL}/me/events`, async (info) => {
        await capture(info);
        return json('event-created');
      }),
    );

    const result = await graphWrites.createEvent(graph(), {
      subject: 'Hold: draft the Northwind renewal note',
      start: '2026-09-24T09:00:00',
      end: '2026-09-24T10:00:00',
      timeZone: 'Europe/London',
    });

    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/v1.0/me/events',
        body: {
          subject: 'Hold: draft the Northwind renewal note',
          start: { dateTime: '2026-09-24T09:00:00', timeZone: 'Europe/London' },
          end: { dateTime: '2026-09-24T10:00:00', timeZone: 'Europe/London' },
          isReminderOn: false,
          showAs: 'busy',
        },
      },
    ]);
    expect(result).toEqual({
      id: 'AAMkAGI2-evt-0303',
      webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI2-evt-0303',
    });
  });
});
