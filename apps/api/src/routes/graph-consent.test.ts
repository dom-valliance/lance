import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../deps.js';
import { buildServer } from '../server.js';
import {
  fakeDeps,
  fakeIdentity,
  fakeVerifier,
  TEST_PRINCIPAL_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { graphConsentConfigurationError } from './graph-consent.js';

const BEARER = { authorization: 'Bearer good-token' };
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const REFRESH_TOKEN = 'the-first-refresh-token';

/** The principal vault as the api sees it: one writer per principal, nothing to read. */
class FakeTokenWriters {
  stored: string | null = null;
  writes = 0;
  readonly principals: string[] = [];

  writerFor = (principalId: string) => ({
    setRefreshToken: (token: string): Promise<void> => {
      this.stored = token;
      this.writes += 1;
      this.principals.push(principalId);
      return Promise.resolve();
    },
  });
}

let harness: FakeDeps;
let tokenStore: FakeTokenWriters;
let server: FastifyInstance;
/** The form each stubbed token request carried. */
let tokenRequests: URLSearchParams[];

const stubTokenEndpoint = (status: number, body: Record<string, unknown>): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = init?.body;
      tokenRequests.push(new URLSearchParams(typeof raw === 'string' ? raw : ''));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
};

/** Runs the connect leg and returns the `state` Entra would send back. */
const startConsent = async (): Promise<string> => {
  const response = await server.inject({
    method: 'GET',
    url: '/auth/graph/connect',
    headers: BEARER,
  });
  const location = response.headers['location'];
  return new URL(String(location)).searchParams.get('state') ?? '';
};

beforeEach(() => {
  harness = fakeDeps();
  tokenStore = new FakeTokenWriters();
  tokenRequests = [];
  const deps: ServerDeps = {
    ...harness.server,
    graph: {
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 'a-client-secret',
      publicApiUrl: 'https://api.example.com',
      tokenWriterFor: tokenStore.writerFor,
    },
  };
  server = buildServer(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

describe('GET /auth/graph/connect', () => {
  it('answers 401 without an Entra bearer token, so only Dom can start a consent', async () => {
    const response = await server.inject({ method: 'GET', url: '/auth/graph/connect' });

    expect(response.statusCode).toBe(401);
  });

  it('redirects to the Entra authorise endpoint with an S256 challenge and a state', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers['location']));
    expect(location.origin).toBe('https://login.microsoftonline.com');
    expect(location.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/auth/graph/callback',
    );
  });

  it('asks for the delegated scopes and never for Mail.Send', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });

    const location = new URL(String(response.headers['location']));
    expect(location.searchParams.get('scope')).toBe(
      'openid offline_access User.Read Mail.ReadWrite Calendars.ReadWrite MailboxSettings.Read',
    );
    expect(response.headers['location']).not.toContain('Mail.Send');
  });

  it('issues a different state on every attempt', async () => {
    const first = await startConsent();
    const second = await startConsent();

    expect(first).not.toBe(second);
  });
});

describe('GET /auth/graph/callback', () => {
  it('answers 400 when the state does not match a consent this api started', async () => {
    await startConsent();

    const response = await server.inject({
      method: 'GET',
      url: '/auth/graph/callback?code=an-auth-code&state=a-state-from-somewhere-else',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('/auth/graph/connect');
    expect(tokenStore.writes).toBe(0);
    expect(harness.writer.appended).toEqual([]);
  });

  it('answers 400 when the state is replayed', async () => {
    stubTokenEndpoint(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'an-access-token',
      refresh_token: REFRESH_TOKEN,
    });
    const state = await startConsent();
    const url = `/auth/graph/callback?code=an-auth-code&state=${state}`;

    await server.inject({ method: 'GET', url });
    const replay = await server.inject({ method: 'GET', url });

    expect(replay.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(1);
  });

  it('answers 400 when Entra reports an error instead of a code', async () => {
    const state = await startConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?error=consent_required&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('consent_required');
    expect(tokenStore.writes).toBe(0);
  });

  it('exchanges the code, stores the refresh token and confirms in British English', async () => {
    stubTokenEndpoint(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'an-access-token',
      refresh_token: REFRESH_TOKEN,
    });
    const state = await startConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Lance is connected');
    expect(response.body).toContain('You can close this tab.');
    expect(tokenStore.stored).toBe(REFRESH_TOKEN);
    // The secret of the principal who started the consent, and nobody else's.
    expect(tokenStore.principals).toEqual([TEST_PRINCIPAL_ID]);

    const sent = tokenRequests[0];
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('code')).toBe('an-auth-code');
    expect(sent?.get('code_verifier')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(sent?.get('redirect_uri')).toBe('https://api.example.com/auth/graph/callback');
  });

  it('appends one state_changed event recording the connection and its scopes', async () => {
    stubTokenEndpoint(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'an-access-token',
      refresh_token: REFRESH_TOKEN,
    });
    const state = await startConsent();

    await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
    });

    expect(harness.writer.appended).toHaveLength(1);
    const event = harness.writer.appended[0];
    expect(event?.kind).toBe('state_changed');
    expect(event?.actor).toBe('user:dom');
    expect(event?.sourceSystem).toBe('graph');
    expect(event?.payload).toEqual({
      change: 'graph_connected',
      scopes: [
        'openid',
        'offline_access',
        'User.Read',
        'Mail.ReadWrite',
        'Calendars.ReadWrite',
        'MailboxSettings.Read',
      ],
    });
  });

  it('keeps the refresh token out of the response, its headers and the ledger payload', async () => {
    stubTokenEndpoint(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'an-access-token',
      refresh_token: REFRESH_TOKEN,
    });
    const state = await startConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
    });

    expect(response.body).not.toContain(REFRESH_TOKEN);
    expect(response.body).not.toContain('an-access-token');
    expect(JSON.stringify(response.headers)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(harness.writer.appended)).not.toContain(REFRESH_TOKEN);
  });

  it('answers 400 without storing anything when Entra refuses the code', async () => {
    stubTokenEndpoint(400, { error: 'invalid_grant' });
    const state = await startConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=a-stale-code&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(0);
    expect(harness.writer.appended).toEqual([]);
  });
});

describe('a consent by a second principal (ADR 0022)', () => {
  it('lets an onboarding principal connect and stores the token in their own secret alone', async () => {
    stubTokenEndpoint(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'an-access-token',
      refresh_token: 'the-colleagues-refresh-token',
    });
    const writers = new FakeTokenWriters();
    const colleague = fakeDeps({
      auth: fakeVerifier({
        'colleague-token': fakeIdentity({ oid: 'oid-colleague', upn: 'colleague@example.test' }),
      }),
    });
    const app = buildServer({
      ...colleague.server,
      graph: {
        tenantId: TENANT,
        clientId: CLIENT,
        clientSecret: 'a-client-secret',
        publicApiUrl: 'https://api.example.com',
        tokenWriterFor: writers.writerFor,
      },
    });

    const connect = await app.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: { authorization: 'Bearer colleague-token' },
    });
    expect(connect.statusCode).toBe(302);
    const state = new URL(String(connect.headers['location'])).searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
    });

    expect(callback.statusCode).toBe(200);
    const created = colleague.directory.principals.get('oid-colleague');
    expect(created?.status).toBe('onboarding');
    expect(writers.principals).toEqual([created?.id]);
    expect(writers.principals).not.toContain(TEST_PRINCIPAL_ID);
    await app.close();
  });
});

describe('an api that was not given the Entra app credentials', () => {
  it('answers 503 rather than half-running the flow', async () => {
    const bare = buildServer(fakeDeps().server);

    const connect = await bare.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });
    const callback = await bare.inject({
      method: 'GET',
      url: '/auth/graph/callback?code=a-code&state=a-state',
    });

    expect(connect.statusCode).toBe(503);
    expect(callback.statusCode).toBe(503);
    await bare.close();
  });

  it('names the missing variables in the error the api logs', () => {
    const error = graphConsentConfigurationError();

    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('PUBLIC_API_URL');
    expect(error.message).toContain('ENTRA_CLIENT_SECRET');
    expect(error.message).toContain('PRINCIPAL_KEY_VAULT_URL');
  });
});
