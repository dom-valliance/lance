import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import {
  createNotionConnector,
  notionPageUrl,
  notionPolicy,
  NOTION_API_VERSION,
} from './client.js';

/** Loads a recorded Notion response. Shape is asserted by the schemas under test. */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../__fixtures__/notion/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

const TOKEN = 'ntn_test_only_never_logged_0000';
const PAGE_ID = 'aa11bb22-cc33-4dd4-8ee5-ff6600112233';
const PAGE_URL = `https://api.notion.com/v1/pages/${PAGE_ID}`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('createNotionConnector', () => {
  it('pins one Notion-Version and sends the token as a bearer header', async () => {
    let seen: Record<string, string | null> = {};
    server.use(
      http.get(PAGE_URL, ({ request }) => {
        seen = {
          authorization: request.headers.get('authorization'),
          version: request.headers.get('notion-version'),
          accept: request.headers.get('accept'),
        };
        return HttpResponse.json(fixture('task-page'));
      }),
    );
    const notion = createNotionConnector({ token: TOKEN });
    await notion.connector.read('getTask', {}, () => notion.send('getTask', `/pages/${PAGE_ID}`));
    expect(seen).toEqual({
      authorization: `Bearer ${TOKEN}`,
      version: NOTION_API_VERSION,
      accept: 'application/json',
    });
  });

  it('applies the published Notion limits of three per second and four attempts', () => {
    expect(notionPolicy).toEqual({
      rateLimit: { capacity: 3, refillPerSecond: 3, maxWaitMs: 20_000 },
      retry: { attempts: 4, baseDelayMs: 400, maxDelayMs: 8_000 },
      breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
    });
  });

  it('retries a 429 once after the Retry-After delay on the injected clock', async () => {
    let calls = 0;
    server.use(
      http.get(PAGE_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(fixture('error-rate-limited'), {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }
        return HttpResponse.json(fixture('task-page'));
      }),
    );
    const clock = new FakeClock();
    const notion = createNotionConnector({ token: TOKEN, clock });
    await notion.connector.read('getTask', {}, () => notion.send('getTask', `/pages/${PAGE_ID}`));
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it('fails a 400 on the first attempt without retrying', async () => {
    let calls = 0;
    server.use(
      http.get(PAGE_URL, () => {
        calls += 1;
        return HttpResponse.json(fixture('error-validation'), { status: 400 });
      }),
    );
    const clock = new FakeClock();
    const notion = createNotionConnector({ token: TOKEN, clock });
    const error = await notion.connector
      .read('getTask', {}, () => notion.send('getTask', `/pages/${PAGE_ID}`))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).retryable).toBe(false);
    expect((error as ConnectorError).status).toBe(400);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('never puts the token in an error message', async () => {
    server.use(
      http.get(PAGE_URL, () => HttpResponse.json(fixture('error-validation'), { status: 401 })),
    );
    const notion = createNotionConnector({ token: TOKEN });
    const error = (await notion.connector
      .read('getTask', {}, () => notion.send('getTask', `/pages/${PAGE_ID}`))
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('Bearer');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('uses an injected fetch when one is given', async () => {
    let requested = '';
    const fetchImpl = ((url: string) => {
      requested = url;
      return Promise.resolve(new Response(JSON.stringify(fixture('task-page')), { status: 200 }));
    }) as unknown as typeof fetch;
    const notion = createNotionConnector({ token: TOKEN, fetchImpl });
    await notion.connector.read('getTask', {}, () => notion.send('getTask', `/pages/${PAGE_ID}`));
    expect(requested).toBe(PAGE_URL);
  });
});

describe('notionPageUrl', () => {
  it('builds the app URL from a dashed page id', () => {
    expect(notionPageUrl(PAGE_ID)).toBe('https://www.notion.so/aa11bb22cc334dd48ee5ff6600112233');
  });
});
