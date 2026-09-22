import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/errors.js';
import * as packageRoot from '../index.js';
import { FakeClock } from '../core/testing.js';
import { createSlackClient } from './client.js';
import { slackReads } from './reads.js';
import { slackWrites } from './writes.js';

interface Captured {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

function stubFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const captured: Captured[] = [];
  const queue = [...responses];
  const fetchImpl = ((url: string, init: RequestInit) => {
    captured.push({
      url,
      auth: new Headers(init.headers).get('authorization'),
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    const next = queue.shift() ?? { status: 200, body: { ok: true } };
    const status = next.status ?? 200;
    const responseInit: ResponseInit =
      next.headers === undefined ? { status } : { status, headers: next.headers };
    return Promise.resolve(new Response(JSON.stringify(next.body), responseInit));
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe('Slack connector', () => {
  it('posts a message as the bot with the token and returns channel and ts', async () => {
    const { fetchImpl, captured } = stubFetch([{ body: { ok: true, channel: 'C1', ts: '1.2' } }]);
    const client = createSlackClient({ token: 'xoxb-test', fetchImpl, clock: new FakeClock() });
    const result = await slackWrites(client).postMessage({
      channel: 'C1',
      text: 'hello',
      blocks: [{ type: 'divider' }],
      threadTs: '1.1',
    });
    expect(result).toEqual({ channel: 'C1', ts: '1.2' });
    expect(captured[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(captured[0]?.auth).toBe('Bearer xoxb-test');
    expect(captured[0]?.body).toMatchObject({
      channel: 'C1',
      text: 'hello',
      thread_ts: '1.1',
      unfurl_links: false,
    });
  });

  it('turns an ok:false reply into a ConnectorError without the token in the message', async () => {
    const { fetchImpl } = stubFetch([{ body: { ok: false, error: 'channel_not_found' } }]);
    const client = createSlackClient({ token: 'xoxb-secret', fetchImpl, clock: new FakeClock() });
    const error = (await slackWrites(client)
      .postMessage({ channel: 'C9', text: 'x' })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('channel_not_found');
    expect(error.message).not.toContain('xoxb-secret');
  });

  it('retries a 429 with Retry-After and then succeeds', async () => {
    const { fetchImpl, captured } = stubFetch([
      { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '1' } },
      { body: { ok: true, channel: 'C1', ts: '9.9' } },
    ]);
    const clock = new FakeClock();
    const client = createSlackClient({ token: 't', fetchImpl, clock });
    const result = await slackWrites(client).updateMessage({
      channel: 'C1',
      ts: '9.9',
      text: 'edited',
    });
    expect(result.ts).toBe('9.9');
    expect(captured).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it('pages channel history until the cursor runs out', async () => {
    const { fetchImpl, captured } = stubFetch([
      {
        body: {
          ok: true,
          messages: [{ type: 'message', ts: '2', text: 'b' }],
          response_metadata: { next_cursor: 'abc' },
        },
      },
      {
        body: {
          ok: true,
          messages: [{ type: 'message', ts: '1', text: 'a' }],
          response_metadata: { next_cursor: '' },
        },
      },
    ]);
    const client = createSlackClient({ token: 't', fetchImpl, clock: new FakeClock() });
    const reads = slackReads(client);
    const first = await reads.conversationsHistory({ channel: 'C1', oldest: '0' });
    expect(first.nextCursor).toBe('abc');
    const second = await reads.conversationsHistory({
      channel: 'C1',
      cursor: first.nextCursor ?? 'none',
    });
    expect(second.nextCursor).toBeNull();
    expect(captured[1]?.body).toMatchObject({ cursor: 'abc' });
  });

  it('opens a modal and posts an ephemeral message', async () => {
    const { fetchImpl } = stubFetch([
      { body: { ok: true, view: { id: 'V1' } } },
      { body: { ok: true, message_ts: '3.3' } },
    ]);
    const client = createSlackClient({ token: 't', fetchImpl, clock: new FakeClock() });
    const writes = slackWrites(client);
    expect(await writes.openView({ triggerId: 'tr', view: { type: 'modal' } })).toEqual({
      viewId: 'V1',
    });
    expect(await writes.postEphemeral({ channel: 'C1', user: 'U1', text: 'only you' })).toEqual({
      messageTs: '3.3',
    });
  });

  it("reports the bot token's own identity from auth.test", async () => {
    const { fetchImpl, captured } = stubFetch([
      { body: { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT', team_id: 'T1' } },
    ]);
    const client = createSlackClient({ token: 't', fetchImpl, clock: new FakeClock() });
    expect(await slackReads(client).authTest()).toEqual({
      userId: 'U0BOT',
      botId: 'B0BOT',
      teamId: 'T1',
    });
    expect(captured[0]?.url).toBe('https://slack.com/api/auth.test');
  });

  it('exposes exactly the four writes spec 8 allows', () => {
    const client = createSlackClient({
      token: 't',
      fetchImpl: stubFetch([]).fetchImpl,
      clock: new FakeClock(),
    });
    expect(Object.keys(slackWrites(client)).sort()).toEqual([
      'openView',
      'postEphemeral',
      'postMessage',
      'updateMessage',
    ]);
  });
});

describe('the Slack write boundary', () => {
  it('keeps no write kind on the client callers hold', () => {
    const client = createSlackClient({
      token: 't',
      fetchImpl: stubFetch([]).fetchImpl,
      clock: new FakeClock(),
    });
    expect(Object.keys(client).sort()).toEqual(['call', 'connector']);
  });

  it('keeps the write accessor out of the package root', () => {
    expect(Object.keys(packageRoot)).not.toContain('slackWriteAccess');
    expect('slackWriteAccess' in packageRoot).toBe(false);
  });
});

describe('write retries', () => {
  const failures = (status: number, count: number) =>
    Array.from({ length: count }, () => ({ status, body: { ok: false, error: 'internal_error' } }));

  it('attempts a post once when Slack may already have delivered it', async () => {
    const { fetchImpl, captured } = stubFetch(failures(503, 4));
    const client = createSlackClient({ token: 't', fetchImpl, clock: new FakeClock() });
    await expect(slackWrites(client).postMessage({ channel: 'C1', text: 'hello' })).rejects.toThrow(
      'HTTP 503',
    );
    expect(captured).toHaveLength(1);
  });

  it('retries an update, which names the message it edits', async () => {
    const { fetchImpl, captured } = stubFetch(failures(503, 4));
    const clock = new FakeClock();
    const client = createSlackClient({ token: 't', fetchImpl, clock });
    await expect(
      slackWrites(client).updateMessage({ channel: 'C1', ts: '9.9', text: 'edited' }),
    ).rejects.toThrow('HTTP 503');
    expect(captured).toHaveLength(4);
  });

  it('attempts a modal open once and an ephemeral post once', async () => {
    const view = stubFetch(failures(503, 4));
    const viewClient = createSlackClient({
      token: 't',
      fetchImpl: view.fetchImpl,
      clock: new FakeClock(),
    });
    await expect(
      slackWrites(viewClient).openView({ triggerId: 'tr', view: { type: 'modal' } }),
    ).rejects.toThrow('HTTP 503');
    expect(view.captured).toHaveLength(1);

    const ephemeral = stubFetch(failures(503, 4));
    const ephemeralClient = createSlackClient({
      token: 't',
      fetchImpl: ephemeral.fetchImpl,
      clock: new FakeClock(),
    });
    await expect(
      slackWrites(ephemeralClient).postEphemeral({ channel: 'C1', user: 'U1', text: 'only you' }),
    ).rejects.toThrow('HTTP 503');
    expect(ephemeral.captured).toHaveLength(1);
  });
});
