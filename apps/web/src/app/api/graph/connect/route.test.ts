import { describe, expect, it, vi } from 'vitest';
import { createConnectProxy } from './route';

vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

const connectUrl = 'http://api.test/auth/graph/connect';

function proxyWith(idToken: string | undefined, upstream: () => Response) {
  const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(upstream()));
  return {
    handler: createConnectProxy({
      idToken: () => Promise.resolve(idToken),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      connectUrl,
    }),
    fetchImpl,
  };
}

describe('GET /api/graph/connect', () => {
  it('refuses without a session token and never calls the api', async () => {
    const { handler, fetchImpl } = proxyWith(undefined, () => new Response(''));

    expect((await handler()).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('starts the consent with the session token and sends the browser to Microsoft', async () => {
    const consentUrl = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=abc';
    const { handler, fetchImpl } = proxyWith(
      'id-token',
      () => new Response(null, { status: 302, headers: { location: consentUrl } }),
    );

    const response = await handler();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(consentUrl);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(connectUrl);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer id-token');
    expect(init.redirect).toBe('manual');
  });

  it('reports an api that did not redirect as 502 with the status', async () => {
    const { handler } = proxyWith('id-token', () => new Response('', { status: 503 }));

    const response = await handler();

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('503');
  });
});
