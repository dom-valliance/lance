import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphConsentDeps, ServerDeps } from '../deps.js';
import { buildServer } from '../server.js';
import {
  fakeConsentStates,
  fakeDeps,
  fakeIdentity,
  fakeVerifier,
  TEST_OID,
  TEST_PRINCIPAL_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { graphConsentConfigurationError } from './graph-consent.js';

const BEARER = { authorization: 'Bearer good-token' };
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const REFRESH_TOKEN = 'the-first-refresh-token';

/** The id tokens the stubbed Entra returns, as the fake verifier reads them. */
const ID_TOKEN = 'id-token-for-dom';
const OTHER_ACCOUNT_ID_TOKEN = 'id-token-for-someone-else';
const OTHER_TENANT_ID_TOKEN = 'id-token-from-another-tenant';

const verifier = () =>
  fakeVerifier({
    'good-token': fakeIdentity(),
    [ID_TOKEN]: fakeIdentity({ tid: TENANT }),
    [OTHER_ACCOUNT_ID_TOKEN]: fakeIdentity({
      oid: 'oid-of-someone-else',
      upn: 'someone.else@valliance.ai',
      tid: TENANT,
    }),
    [OTHER_TENANT_ID_TOKEN]: fakeIdentity({ tid: 'another-tenant' }),
  });

const TOKENS = {
  token_type: 'Bearer',
  expires_in: 3600,
  access_token: 'an-access-token',
  refresh_token: REFRESH_TOKEN,
  id_token: ID_TOKEN,
};

/** The principal vault as the api sees it: one writer per principal, nothing to read. */
class FakeTokenWriters {
  stored: string | null = null;
  writes = 0;
  readonly principals: string[] = [];
  /** The ledger changes recorded when each write happened. */
  readonly ledgerAtWrite: string[][] = [];

  constructor(private readonly ledger: () => string[] = () => []) {}

  writerFor = (principalId: string) => ({
    setRefreshToken: (token: string): Promise<void> => {
      this.stored = token;
      this.writes += 1;
      this.principals.push(principalId);
      this.ledgerAtWrite.push(this.ledger());
      return Promise.resolve();
    },
  });
}

const changes = (h: FakeDeps): string[] =>
  h.writer.appended.map((event) => String((event.payload as { change?: unknown }).change));

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

/** The cookie a Set-Cookie header sets, as a browser would send it back. */
const cookieFrom = (setCookie: string | string[] | number | undefined): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ?? '';

/**
 * Runs the connect and begin legs as the principal's browser would, and
 * returns the `state` Entra sends back and the cookie the browser holds.
 */
const beginConsent = async (
  app: FastifyInstance = server,
  bearer = BEARER,
): Promise<{ state: string; cookie: string; authorise: URL }> => {
  const connect = await app.inject({ method: 'GET', url: '/auth/graph/connect', headers: bearer });
  const begin = new URL(String(connect.headers['location']));
  const response = await app.inject({ method: 'GET', url: `${begin.pathname}${begin.search}` });
  const authorise = new URL(String(response.headers['location']));
  return {
    state: authorise.searchParams.get('state') ?? '',
    cookie: cookieFrom(response.headers['set-cookie']),
    authorise,
  };
};

const startConsent = async (): Promise<string> => (await beginConsent()).state;

/** The callback as the principal's own browser sends it, cookie and all. */
const callback = async (query: string, app: FastifyInstance = server) => {
  const state = new URLSearchParams(query).get('state') ?? '';
  return app.inject({
    method: 'GET',
    url: `/auth/graph/callback?${query}`,
    headers: { cookie: `lance_graph_consent=${state}` },
  });
};

const graphDepsFor = (h: FakeDeps, writers: FakeTokenWriters): GraphConsentDeps => ({
  tenantId: TENANT,
  clientId: CLIENT,
  clientSecret: 'a-client-secret',
  publicApiUrl: 'https://api.example.com',
  tokenWriterFor: writers.writerFor,
  states: fakeConsentStates(h.directory),
});

beforeEach(() => {
  harness = fakeDeps({ auth: verifier() });
  tokenStore = new FakeTokenWriters(() => changes(harness));
  tokenRequests = [];
  const deps: ServerDeps = { ...harness.server, graph: graphDepsFor(harness, tokenStore) };
  server = buildServer(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

describe('GET /auth/graph/connect', () => {
  it('answers 401 without an Entra bearer token, so only a principal can start a consent', async () => {
    const response = await server.inject({ method: 'GET', url: '/auth/graph/connect' });

    expect(response.statusCode).toBe(401);
  });

  it('sends the browser to the begin leg on the api hostname with a state naming the principal', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers['location']));
    expect(location.origin).toBe('https://api.example.com');
    expect(location.pathname).toBe('/auth/graph/begin');
    expect(location.searchParams.get('state')).toMatch(
      new RegExp(`^${TEST_PRINCIPAL_ID}\\.[A-Za-z0-9\\-_]{43}$`),
    );
  });

  it('issues a different state on every attempt', async () => {
    const first = await startConsent();
    const second = await startConsent();

    expect(first).not.toBe(second);
  });
});

describe('GET /auth/graph/begin', () => {
  it('redirects to the Entra authorise endpoint with an S256 challenge and the state', async () => {
    const { authorise, state } = await beginConsent();

    expect(authorise.origin).toBe('https://login.microsoftonline.com');
    expect(authorise.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(authorise.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorise.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(state.startsWith(`${TEST_PRINCIPAL_ID}.`)).toBe(true);
    expect(authorise.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/auth/graph/callback',
    );
  });

  it('asks Entra for the principal account by login and domain hint', async () => {
    const { authorise } = await beginConsent();

    expect(authorise.searchParams.get('login_hint')).toBe('dom@valliance.ai');
    expect(authorise.searchParams.get('domain_hint')).toBe('valliance.ai');
  });

  it('asks for the delegated scopes and never for Mail.Send', async () => {
    const { authorise } = await beginConsent();

    expect(authorise.searchParams.get('scope')).toBe(
      'openid offline_access User.Read Mail.ReadWrite Calendars.ReadWrite MailboxSettings.Read',
    );
    expect(authorise.toString()).not.toContain('Mail.Send');
  });

  it('binds the state to the browser with an HttpOnly, SameSite=Lax, secure cookie', async () => {
    const connect = await server.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });
    const begin = new URL(String(connect.headers['location']));
    const response = await server.inject({
      method: 'GET',
      url: `${begin.pathname}${begin.search}`,
    });

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`lance_graph_consent=${begin.searchParams.get('state') ?? ''}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/auth/graph');
    expect(setCookie).toContain('Max-Age=600');
  });

  it('binds a state once, so a forwarded begin link does nothing after the principal used it', async () => {
    const connect = await server.inject({
      method: 'GET',
      url: '/auth/graph/connect',
      headers: BEARER,
    });
    const begin = new URL(String(connect.headers['location']));
    const url = `${begin.pathname}${begin.search}`;

    await server.inject({ method: 'GET', url });
    const second = await server.inject({ method: 'GET', url });

    expect(second.statusCode).toBe(400);
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('answers 400 for a state Lance never issued', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/begin?state=${TEST_PRINCIPAL_ID}.not-a-state-lance-issued-at-all-ever`,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /auth/graph/callback', () => {
  it('answers 400 when the state does not match a consent this api started', async () => {
    await startConsent();

    const response = await callback(
      `code=an-auth-code&state=${TEST_PRINCIPAL_ID}.a-state-from-somewhere-else-entirely`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('Connect Microsoft 365');
    expect(tokenStore.writes).toBe(0);
    expect(harness.writer.appended).toEqual([]);
  });

  it('refuses a callback from a browser that did not begin the consent, storing nothing', async () => {
    stubTokenEndpoint(200, TOKENS);
    const { state } = await beginConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('not started in this browser');
    expect(tokenRequests).toEqual([]);
    expect(tokenStore.writes).toBe(0);
  });

  it('refuses a cookie that belongs to a different consent', async () => {
    stubTokenEndpoint(200, TOKENS);
    const { state } = await beginConsent();
    const { cookie } = await beginConsent();

    const response = await server.inject({
      method: 'GET',
      url: `/auth/graph/callback?code=an-auth-code&state=${state}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(0);
  });

  it('refuses a consent granted by another account and stores nothing', async () => {
    stubTokenEndpoint(200, { ...TOKENS, id_token: OTHER_ACCOUNT_ID_TOKEN });
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toContain('dom@valliance.ai');
    expect(tokenStore.writes).toBe(0);
    expect(changes(harness)).toEqual(['graph_consent_refused']);
    expect(harness.writer.appended[0]?.payload).toEqual({
      change: 'graph_consent_refused',
      reason: 'account_mismatch',
    });
  });

  it('refuses an id token from another tenant', async () => {
    stubTokenEndpoint(200, { ...TOKENS, id_token: OTHER_TENANT_ID_TOKEN });
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.statusCode).toBe(403);
    expect(tokenStore.writes).toBe(0);
  });

  it('refuses a token response without a verifiable id token', async () => {
    stubTokenEndpoint(200, { ...TOKENS, id_token: undefined });
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(0);
    expect(changes(harness)).toEqual(['graph_consent_refused']);
  });

  it('answers 400 when the state is replayed', async () => {
    stubTokenEndpoint(200, TOKENS);
    const state = await startConsent();
    const query = `code=an-auth-code&state=${state}`;

    await callback(query);
    const replay = await callback(query);

    expect(replay.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(1);
  });

  it('answers 400 when Entra reports an error instead of a code', async () => {
    const state = await startConsent();

    const response = await callback(`error=consent_required&state=${state}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('consent_required');
    expect(tokenStore.writes).toBe(0);
  });

  it('exchanges the code, stores the refresh token and confirms in British English', async () => {
    stubTokenEndpoint(200, TOKENS);
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Lance is connected');
    expect(response.body).toContain('You can close this tab.');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect(tokenStore.stored).toBe(REFRESH_TOKEN);
    // The secret of the principal who started the consent, and nobody else's.
    expect(tokenStore.principals).toEqual([TEST_PRINCIPAL_ID]);

    const sent = tokenRequests[0];
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('code')).toBe('an-auth-code');
    expect(sent?.get('code_verifier')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(sent?.get('redirect_uri')).toBe('https://api.example.com/auth/graph/callback');
  });

  it('records the intent before the secret is written and the connection after', async () => {
    stubTokenEndpoint(200, TOKENS);
    const state = await startConsent();

    await callback(`code=an-auth-code&state=${state}`);

    expect(tokenStore.ledgerAtWrite).toEqual([['graph_token_storing']]);
    expect(changes(harness)).toEqual(['graph_token_storing', 'graph_connected']);
    const event = harness.writer.appended[1];
    expect(event?.kind).toBe('state_changed');
    expect(event?.actor).toBe('user:dom');
    expect(event?.sourceSystem).toBe('graph');
    expect(event?.correlationId).toBe(harness.writer.appended[0]?.correlationId);
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
    stubTokenEndpoint(200, TOKENS);
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.body).not.toContain(REFRESH_TOKEN);
    expect(response.body).not.toContain('an-access-token');
    expect(JSON.stringify(response.headers)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(harness.writer.appended)).not.toContain(REFRESH_TOKEN);
  });

  it('answers 400 without storing anything when Entra refuses the code', async () => {
    stubTokenEndpoint(400, { error: 'invalid_grant' });
    const state = await startConsent();

    const response = await callback(`code=a-stale-code&state=${state}`);

    expect(response.statusCode).toBe(400);
    expect(tokenStore.writes).toBe(0);
    expect(harness.writer.appended).toEqual([]);
  });
});

describe('a consent by a second principal (ADR 0022)', () => {
  it('lets an onboarding principal connect and stores the token in their own secret alone', async () => {
    stubTokenEndpoint(200, {
      ...TOKENS,
      refresh_token: 'the-colleagues-refresh-token',
      id_token: 'colleague-id-token',
    });
    const colleagueIdentity = fakeIdentity({ oid: 'oid-colleague', upn: 'colleague@example.test' });
    const colleague = fakeDeps({
      auth: fakeVerifier({
        'colleague-token': colleagueIdentity,
        'colleague-id-token': { ...colleagueIdentity, tid: TENANT },
      }),
    });
    const writers = new FakeTokenWriters();
    const app = buildServer({ ...colleague.server, graph: graphDepsFor(colleague, writers) });

    const { state } = await beginConsent(app, { authorization: 'Bearer colleague-token' });
    const response = await callback(`code=an-auth-code&state=${state}`, app);

    expect(response.statusCode).toBe(200);
    const created = colleague.directory.principals.get('oid-colleague');
    expect(created?.status).toBe('onboarding');
    expect(writers.principals).toEqual([created?.id]);
    expect(writers.principals).not.toContain(TEST_PRINCIPAL_ID);
    await app.close();
  });

  it('refuses when a colleague consents on a link another principal forwarded', async () => {
    // Dom starts the consent; the colleague opens the Microsoft page with Dom's cookie jar
    // (the strongest case: the cookie check passed) and consents as themselves.
    stubTokenEndpoint(200, { ...TOKENS, id_token: OTHER_ACCOUNT_ID_TOKEN });
    const state = await startConsent();

    const response = await callback(`code=an-auth-code&state=${state}`);

    expect(response.statusCode).toBe(403);
    expect(tokenStore.principals).toEqual([]);
    expect(harness.directory.principals.get(TEST_OID)?.id).toBe(TEST_PRINCIPAL_ID);
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
    const callbackResponse = await bare.inject({
      method: 'GET',
      url: '/auth/graph/callback?code=a-code&state=a-state',
    });

    expect(connect.statusCode).toBe(503);
    expect(callbackResponse.statusCode).toBe(503);
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
