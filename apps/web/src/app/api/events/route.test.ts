import { describe, expect, it, vi } from 'vitest';
import { createEventsProxy } from './route';

vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

const upstreamUrl = 'http://api.test/events';

function proxyWith(
  idToken: string | undefined,
  upstream: (url: string, init: RequestInit | undefined) => Response,
) {
  const fetchImpl = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(upstream(url, init)),
  ) as unknown as typeof fetch;
  const handler = createEventsProxy({
    idToken: () => Promise.resolve(idToken),
    fetchImpl,
    upstreamUrl,
  });
  return { handler, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

describe('GET /api/events', () => {
  it('refuses a request with no session token without calling the api', async () => {
    const { handler, fetchImpl } = proxyWith(undefined, () => new Response(''));

    const response = await handler(new Request('http://web.test/api/events'));

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opens the api stream with the session token as the bearer and passes the body through', async () => {
    const { handler, fetchImpl } = proxyWith(
      'id-token',
      () =>
        new Response('data: {"type":"proposal"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const response = await handler(new Request('http://web.test/api/events'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: {"type":"proposal"}\n\n');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(upstreamUrl);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer id-token');
  });

  it('keeps the token out of the request the browser made', async () => {
    const { handler } = proxyWith('id-token', () => new Response('', { status: 200 }));
    const request = new Request('http://web.test/api/events');

    await handler(request);

    expect(request.url).not.toContain('id-token');
  });

  it('reports an api refusal as 401 and any other upstream failure as 502', async () => {
    const refused = proxyWith('stale', () => new Response('', { status: 401 }));
    const broken = proxyWith('id-token', () => new Response('', { status: 503 }));

    expect((await refused.handler(new Request('http://web.test/api/events'))).status).toBe(401);
    expect((await broken.handler(new Request('http://web.test/api/events'))).status).toBe(502);
  });
});
