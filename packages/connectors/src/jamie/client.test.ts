import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import {
  createJamieConnector,
  jamieProcedurePath,
  jamiePolicy,
  JAMIE_HEALTH_PATH,
  type JamieReadRequest,
} from './client.js';
import { JAMIE_API_BASE_URL } from './types.js';

const API_KEY = 'jk_test_only_never_logged_0000';
const LIST_URL = `${JAMIE_API_BASE_URL}${jamieProcedurePath('meetings.list')}`;
const HEALTH_URL = `${JAMIE_API_BASE_URL}${JAMIE_HEALTH_PATH}`;

const payloadSchema = z.looseObject({ meetings: z.array(z.looseObject({ id: z.string() })) });
const healthSchema = z.looseObject({ status: z.string() });

/** One tRPC reply, as Jamie wraps it. */
const envelope = (json: unknown): Record<string, unknown> => ({ result: { data: { json } } });

/** One tRPC error reply. The HTTP status matches `data.httpStatus`. */
const trpcError = (code: string, httpStatus: number): Record<string, unknown> => ({
  error: {
    json: { message: 'Jamie refused the request.', code: -32600, data: { code, httpStatus } },
  },
});

const ONE_MEETING = { meetings: [{ id: 'mtg_0000000000000001' }], nextCursor: null };

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connect(clock = new FakeClock()) {
  return createJamieConnector({ apiKey: API_KEY, clock });
}

function listMeetings(
  jamie: ReturnType<typeof connect>,
  request?: JamieReadRequest,
): Promise<unknown> {
  return jamie.connector.read('listMeetings', {}, () =>
    jamie.send('listMeetings', jamieProcedurePath('meetings.list'), payloadSchema, request),
  );
}

describe('createJamieConnector', () => {
  it('sends the personal key in the x-api-key header and asks for JSON', async () => {
    let seen: Record<string, string | null> = {};
    server.use(
      http.get(LIST_URL, ({ request }) => {
        seen = {
          key: request.headers.get('x-api-key'),
          accept: request.headers.get('accept'),
        };
        return HttpResponse.json(envelope(ONE_MEETING));
      }),
    );
    await listMeetings(connect());
    expect(seen).toEqual({ key: API_KEY, accept: 'application/json' });
  });

  it('encodes the input as one URL-encoded input parameter wrapped in json', async () => {
    let raw: string | null = null;
    server.use(
      http.get(LIST_URL, ({ request }) => {
        raw = new URL(request.url).searchParams.get('input');
        return HttpResponse.json(envelope(ONE_MEETING));
      }),
    );
    await listMeetings(connect(), { input: { limit: 10, tag: 'delivery' } });
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as unknown as string)).toEqual({ json: { limit: 10, tag: 'delivery' } });
  });

  it('omits the input parameter for a procedure that takes no input', async () => {
    let url = '';
    server.use(
      http.get(LIST_URL, ({ request }) => {
        url = request.url;
        return HttpResponse.json(envelope(ONE_MEETING));
      }),
    );
    await listMeetings(connect());
    expect(new URL(url).searchParams.has('input')).toBe(false);
  });

  it('unwraps the payload from result.data.json', async () => {
    server.use(http.get(LIST_URL, () => HttpResponse.json(envelope(ONE_MEETING))));
    await expect(listMeetings(connect())).resolves.toEqual(ONE_MEETING);
  });

  it('refuses a reply that is not a tRPC envelope, naming the path', async () => {
    server.use(http.get(LIST_URL, () => HttpResponse.json({ meetings: [] })));
    const error = (await listMeetings(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('not a tRPC envelope at result');
    expect(error.message).toContain('packages/connectors/src/jamie/types.ts');
  });

  it('refuses a payload that does not match the schema, naming the path', async () => {
    server.use(http.get(LIST_URL, () => HttpResponse.json(envelope({ meetings: [{}] }))));
    const error = (await listMeetings(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('did not match the expected shape at meetings.0.id');
  });

  it('fails a 400 tRPC error on the first attempt without retrying', async () => {
    let calls = 0;
    server.use(
      http.get(LIST_URL, () => {
        calls += 1;
        return HttpResponse.json(trpcError('BAD_REQUEST', 400), { status: 400 });
      }),
    );
    const clock = new FakeClock();
    const error = (await listMeetings(connect(clock)).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('fails a 404 tRPC error on the first attempt without retrying', async () => {
    let calls = 0;
    server.use(
      http.get(LIST_URL, () => {
        calls += 1;
        return HttpResponse.json(trpcError('NOT_FOUND', 404), { status: 404 });
      }),
    );
    const error = (await listMeetings(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries a 429 after the delay computed from X-RateLimit-Reset', async () => {
    let calls = 0;
    server.use(
      http.get(LIST_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(trpcError('TOO_MANY_REQUESTS', 429), {
            status: 429,
            headers: {
              'x-ratelimit-limit': '100',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '5',
            },
          });
        }
        return HttpResponse.json(envelope(ONE_MEETING));
      }),
    );
    const clock = new FakeClock();
    await listMeetings(connect(clock));
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([5000]);
  });

  it('clamps a reset far in the future to sixty seconds', async () => {
    server.use(
      http.get(LIST_URL, () =>
        HttpResponse.json(trpcError('TOO_MANY_REQUESTS', 429), {
          status: 429,
          headers: { 'x-ratelimit-reset': '99999999' },
        }),
      ),
    );
    const error = (await listMeetings(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(60);
  });

  it('clamps a reset already past to one second', async () => {
    server.use(
      http.get(LIST_URL, () =>
        HttpResponse.json(trpcError('TOO_MANY_REQUESTS', 429), {
          status: 429,
          headers: { 'x-ratelimit-reset': '0' },
        }),
      ),
    );
    const clock = new FakeClock();
    clock.advance(10_000);
    const error = (await listMeetings(connect(clock)).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.retryAfterSeconds).toBe(1);
  });

  it('prefers Retry-After over the reset header when the 429 carries both', async () => {
    let calls = 0;
    server.use(
      http.get(LIST_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(trpcError('TOO_MANY_REQUESTS', 429), {
            status: 429,
            headers: { 'retry-after': '2', 'x-ratelimit-reset': '45' },
          });
        }
        return HttpResponse.json(envelope(ONE_MEETING));
      }),
    );
    const clock = new FakeClock();
    await listMeetings(connect(clock));
    expect(clock.sleeps).toEqual([2000]);
  });

  it('refuses any method but GET, naming the read-only decision', async () => {
    const jamie = connect();
    const error = (await jamie
      .send('listMeetings', jamieProcedurePath('meetings.list'), payloadSchema, {
        method: 'POST',
      } as unknown as JamieReadRequest)
      .catch((caught: unknown) => caught)) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('read-only and refuses POST');
  });

  it('reads the health route without sending the key and without unwrapping', async () => {
    let key: string | null = 'unset';
    server.use(
      http.get(HEALTH_URL, ({ request }) => {
        key = request.headers.get('x-api-key');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    const jamie = connect();
    const health = await jamie.send('checkAccess', JAMIE_HEALTH_PATH, healthSchema, {
      route: 'plain',
    });
    expect(health).toEqual({ status: 'ok' });
    expect(key).toBeNull();
  });

  it('never puts the API key in an error message', async () => {
    server.use(
      http.get(LIST_URL, () => HttpResponse.json(trpcError('UNAUTHORIZED', 401), { status: 401 })),
    );
    const error = (await listMeetings(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('uses an injected fetch when one is given', async () => {
    let requested = '';
    const fetchImpl = ((url: string) => {
      requested = url;
      return Promise.resolve(new Response(JSON.stringify(envelope(ONE_MEETING)), { status: 200 }));
    }) as unknown as typeof fetch;
    const jamie = createJamieConnector({ apiKey: API_KEY, clock: new FakeClock(), fetchImpl });
    await listMeetings(jamie);
    expect(requested).toBe(LIST_URL);
  });

  it('holds its sustained rate well under Jamie hundred requests a minute', () => {
    expect(jamiePolicy.rateLimit).toEqual({ capacity: 10, refillPerSecond: 1, maxWaitMs: 20_000 });
    expect(jamiePolicy.rateLimit.refillPerSecond * 60).toBeLessThan(100);
  });
});
