import { describe, expect, it } from 'vitest';
import { ConnectorError } from './errors.js';
import { fetchJson } from './http.js';

const respond =
  (status: number, body: string | null, headers: Record<string, string> = {}): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status, headers }));

describe('fetchJson', () => {
  it('parses a JSON body and returns the status and headers', async () => {
    const result = await fetchJson<{ ok: boolean }>(
      'graph',
      'op',
      'https://x.test',
      {},
      respond(200, '{"ok":true}'),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });

  it('treats 204 and empty bodies as undefined', async () => {
    const a = await fetchJson('graph', 'op', 'https://x.test', {}, respond(204, null));
    const b = await fetchJson('graph', 'op', 'https://x.test', {}, respond(200, ''));
    expect(a.body).toBeUndefined();
    expect(b.body).toBeUndefined();
  });

  it('maps 429 to a retryable error carrying Retry-After and no body', async () => {
    const error = await fetchJson(
      'notion',
      'op',
      'https://x.test',
      {},
      respond(429, '{"secret":"x"}', { 'retry-after': '7' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    const connectorError = error as ConnectorError;
    expect(connectorError.retryable).toBe(true);
    expect(connectorError.status).toBe(429);
    expect(connectorError.retryAfterSeconds).toBe(7);
    expect(connectorError.message).not.toContain('secret');
  });

  it('maps 400 to a non-retryable error', async () => {
    const error = (await fetchJson('graph', 'op', 'https://x.test', {}, respond(400, '{}')).catch(
      (e: unknown) => e,
    )) as ConnectorError;
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  it('wraps a network failure as retryable', async () => {
    const failing = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const error = (await fetchJson('graph', 'op', 'https://x.test', {}, failing).catch(
      (e: unknown) => e,
    )) as ConnectorError;
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
  });

  it('sends JSON bodies with the content type and the method', async () => {
    let seen: { method: string | undefined; contentType: string | null; body: string | undefined } =
      {
        method: undefined,
        contentType: null,
        body: undefined,
      };
    const capture = ((_url: string, init: RequestInit) => {
      seen = {
        method: init.method,
        contentType: new Headers(init.headers).get('content-type'),
        body: init.body as string,
      };
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    await fetchJson('graph', 'op', 'https://x.test', { method: 'POST', body: { a: 1 } }, capture);
    expect(seen).toEqual({ method: 'POST', contentType: 'application/json', body: '{"a":1}' });
  });
});
