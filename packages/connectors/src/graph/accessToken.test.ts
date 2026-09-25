import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/index.js';
import { createAccessTokenProvider } from './accessToken.js';
import { TokenRefreshError } from './auth.js';
import { InMemoryTokenStore } from './tokenStore.js';

/**
 * The provider is exercised over a stub `fetch` rather than msw: these
 * tests are about how often the token endpoint is called and what is
 * written back to the store, and a counting stub says both directly.
 */

const TENANT = '11111111-2222-3333-4444-555555555555';

interface TokenEndpointStub {
  fetchImpl: typeof fetch;
  /** The `refresh_token` field of each request, in order. */
  sent: string[];
}

const respondsWith = (
  bodies: { status: number; body: Record<string, unknown> }[],
): TokenEndpointStub => {
  const sent: string[] = [];
  const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    const form = new URLSearchParams(typeof body === 'string' ? body : '');
    sent.push(form.get('refresh_token') ?? '');
    const next = bodies[Math.min(sent.length - 1, bodies.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify(next?.body ?? {}), {
        status: next?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

const tokenPair = (index: number, expiresIn = 3600): Record<string, unknown> => ({
  token_type: 'Bearer',
  expires_in: expiresIn,
  access_token: `access-${index}`,
  refresh_token: `refresh-${index}`,
});

const providerOver = (
  store: InMemoryTokenStore,
  stub: TokenEndpointStub,
  onRefreshFailed?: (error: TokenRefreshError) => void,
): (() => Promise<string>) =>
  createAccessTokenProvider({
    store,
    tenantId: TENANT,
    clientId: 'a-client-id',
    clientSecret: 'a-client-secret',
    fetchImpl: stub.fetchImpl,
    ...(onRefreshFailed === undefined ? {} : { onRefreshFailed }),
  });

describe('the access token provider', () => {
  it('refreshes once for concurrent callers and hands them the same token', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([{ status: 200, body: tokenPair(1) }]);
    const accessToken = providerOver(store, stub);

    const tokens = await Promise.all([accessToken(), accessToken(), accessToken()]);

    expect(tokens).toEqual(['access-1', 'access-1', 'access-1']);
    expect(stub.sent).toEqual(['refresh-0']);
  });

  it('writes the rotated refresh token back to the store', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([{ status: 200, body: tokenPair(1) }]);

    await providerOver(store, stub)();

    await expect(store.getRefreshToken()).resolves.toBe('refresh-1');
  });

  it('reuses the cached access token until it is close to expiry', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([{ status: 200, body: tokenPair(1) }]);
    const accessToken = providerOver(store, stub);

    await accessToken();
    await accessToken();

    expect(stub.sent).toHaveLength(1);
  });

  it('refreshes again when the cached token is inside the two-minute margin', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([
      { status: 200, body: tokenPair(1, 60) },
      { status: 200, body: tokenPair(2, 3600) },
    ]);
    const accessToken = providerOver(store, stub);

    await expect(accessToken()).resolves.toBe('access-1');
    await expect(accessToken()).resolves.toBe('access-2');

    expect(stub.sent).toEqual(['refresh-0', 'refresh-1']);
  });

  it('surfaces TokenRefreshError and calls onRefreshFailed once on invalid_grant', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([{ status: 400, body: { error: 'invalid_grant' } }]);
    const failures: TokenRefreshError[] = [];
    const accessToken = providerOver(store, stub, (error) => {
      failures.push(error);
    });

    const results = await Promise.allSettled([accessToken(), accessToken()]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TokenRefreshError);
    expect(stub.sent).toEqual(['refresh-0']);
  });

  it('leaves the stored token alone when the refresh is refused', async () => {
    const store = new InMemoryTokenStore('refresh-0');
    const stub = respondsWith([{ status: 400, body: { error: 'invalid_grant' } }]);

    await expect(providerOver(store, stub)()).rejects.toBeInstanceOf(TokenRefreshError);

    await expect(store.getRefreshToken()).resolves.toBe('refresh-0');
  });

  it('says how to connect when no refresh token has been stored', async () => {
    const store = new InMemoryTokenStore();
    const stub = respondsWith([{ status: 200, body: tokenPair(1) }]);

    const error = (await providerOver(store, stub)().catch(
      (caught: unknown) => caught,
    )) as ConnectorError;

    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('/auth/graph/connect');
    expect(stub.sent).toEqual([]);
  });

  it('never puts a token in the message when the refresh fails', async () => {
    const store = new InMemoryTokenStore('a-secret-refresh-token');
    const stub = respondsWith([{ status: 400, body: { error: 'invalid_grant' } }]);

    const error = (await providerOver(store, stub)().catch(
      (caught: unknown) => caught,
    )) as TokenRefreshError;

    expect(error.message).not.toContain('a-secret-refresh-token');
  });

  it('holds the rotation lock across the read, the refresh and the write', async () => {
    const events: string[] = [];
    const inner = new InMemoryTokenStore('refresh-0');
    const store = {
      getRefreshToken: async () => {
        events.push('read');
        return inner.getRefreshToken();
      },
      setRefreshToken: async (token: string) => {
        events.push('write');
        await inner.setRefreshToken(token);
      },
    };
    const stub = respondsWith([{ status: 200, body: tokenPair(1) }]);
    const accessToken = createAccessTokenProvider({
      store,
      tenantId: TENANT,
      clientId: 'a-client-id',
      clientSecret: 'a-client-secret',
      fetchImpl: stub.fetchImpl,
      rotationLock: async (work) => {
        events.push('lock');
        try {
          return await work();
        } finally {
          events.push('unlock');
        }
      },
    });

    await Promise.all([accessToken(), accessToken()]);

    expect(events).toEqual(['lock', 'read', 'write', 'unlock']);
  });

  it("uses the caller's not-connected message when one is given", async () => {
    const accessToken = createAccessTokenProvider({
      store: new InMemoryTokenStore(),
      tenantId: TENANT,
      clientId: 'a-client-id',
      clientSecret: 'a-client-secret',
      fetchImpl: respondsWith([]).fetchImpl,
      notConnectedMessage: 'graph token: principal X has not connected Microsoft 365.',
    });

    await expect(accessToken()).rejects.toThrow('principal X has not connected');
  });
});
