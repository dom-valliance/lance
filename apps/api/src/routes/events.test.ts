import type { FastifyInstance } from 'fastify';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { fakeDeps, type FakeDeps } from '../test-fakes.js';

/**
 * The stream never ends on its own, so these tests listen on an ephemeral
 * port and read it with `fetch` and an `AbortController`. `server.inject`
 * would wait for a response that, by design, does not finish.
 */

let harness: FakeDeps;
let server: FastifyInstance;
let origin: string;

const readFirstEvent = async (url: string): Promise<string> => {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { authorization: 'Bearer good-token' },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  // Node's fetch types the body as ReadableStream<any>; naming the chunk
  // type keeps the decode below off `any`.
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) throw new Error('The stream carried no body.');
  const decoder = new TextDecoder();
  let seen = '';

  try {
    // The first chunk is the connection comment; the event follows it.
    while (!seen.includes('data:')) {
      harness.deps.notify({ type: 'proposal', id: '01K5S9V6QW3SWCCPVB0N0E301A' });
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
  } finally {
    controller.abort();
  }
  return seen;
};

beforeEach(async () => {
  harness = fakeDeps();
  server = buildServer(harness.deps);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await server.close();
});

describe('GET /events', () => {
  it('streams a proposal event to a client that sent the token in the Authorization header', async () => {
    const seen = await readFirstEvent(`${origin}/events`);

    expect(seen).toContain('"type":"proposal"');
    expect(seen).toContain('"id":"01K5S9V6QW3SWCCPVB0N0E301A"');
  });

  it('refuses a request with no token', async () => {
    const response = await fetch(`${origin}/events`);

    expect(response.status).toBe(401);
  });

  it('ignores a token sent as a query parameter', async () => {
    const response = await fetch(`${origin}/events?access_token=good-token`);

    expect(response.status).toBe(401);
  });

  it('refuses a token the verifier rejects', async () => {
    const response = await fetch(`${origin}/events`, {
      headers: { authorization: 'Bearer stale-token' },
    });

    expect(response.status).toBe(401);
  });

  it('removes the subscriber once the client disconnects', async () => {
    // The harness already watches the feed, so the count is relative.
    // node:http rather than fetch: destroying the request closes the socket
    // at once, where an aborted fetch waits out undici's keep-alive.
    const before = harness.feed.size;
    const request = get(`${origin}/events`, {
      headers: { authorization: 'Bearer good-token' },
    });
    await new Promise<void>((resolve) => request.once('response', () => resolve()));
    expect(harness.feed.size).toBe(before + 1);

    request.destroy();
    await vi.waitFor(() => {
      expect(harness.feed.size).toBe(before);
    });
  });
});
